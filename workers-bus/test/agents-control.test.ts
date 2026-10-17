import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi, handleAgentTeamAppRoute } from "../src/agents/api.ts";
import { appendSignal, type BoundStatement } from "../src/agents/store.ts";
import { currentDelegation, specialistControl } from "../src/agents/control.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { WorkerClient } from "../../agent-host/src/host/worker.ts";
import type { AuthContext, AppRole } from "../src/app-types.ts";

const TENANT = "ironwrap";
const TOKEN = "synthetic-agent-host-token-0001";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Real SQLite, including D1's atomic batch and trigger-inclusive change counts. */
class SqliteD1 {
  raw = new DatabaseSync(":memory:");
  beforeBatch: (() => void | Promise<void>) | null = null;
  beforeStepInsert: (() => Promise<void>) | null = null;
  afterExceptionInsert: (() => Promise<void>) | null = null;
  private tail: Promise<void> = Promise.resolve();
  constructor(fullSchema = false) {
    this.raw.exec("PRAGMA foreign_keys=ON");
    const files = fullSchema
      ? readdirSync(new URL("../migrations/", import.meta.url))
          .filter((file) => /^\d+.*\.sql$/.test(file))
          .sort()
      : ["0011_app_bff_auth.sql", "0200_agent_coordination.sql", "0201_agent_delegation.sql"];
    for (const file of files) {
      if (!fullSchema && file === "0200_agent_coordination.sql")
        this.raw.exec("ALTER TABLE app_users ADD COLUMN access_role TEXT");
      this.raw.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
    }
  }
  prepare(sql: string) {
    return {
      bind: (...values: unknown[]) => {
        const args = values as Array<string | number | null>;
        return {
          first: async <T>() => (this.raw.prepare(sql).get(...args) ?? null) as T | null,
          all: async <T>() => ({
            results: this.raw.prepare(sql).all(...args) as T[],
          }),
          run: async () => {
            if (sql.includes("INSERT INTO agent_run_steps") && this.beforeStepInsert) {
              const hook = this.beforeStepInsert;
              this.beforeStepInsert = null;
              await hook();
            }
            const count = () =>
              Number(
                (
                  this.raw.prepare("SELECT total_changes() AS n").get() as {
                    n: number;
                  }
                ).n,
              );
            const before = count();
            this.raw.prepare(sql).run(...args);
            const result = { meta: { changes: count() - before } };
            if (sql.includes("INSERT INTO agent_exceptions") && this.afterExceptionInsert) {
              const hook = this.afterExceptionInsert;
              this.afterExceptionInsert = null;
              await hook();
            }
            return result;
          },
        };
      },
    };
  }
  async batch(statements: BoundStatement[]) {
    // Pause/hold may commit after policy was read but before this transaction acquires admission.
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
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        this.raw.exec("COMMIT");
        return result;
      } catch (error) {
        this.raw.exec("ROLLBACK");
        throw error;
      }
    } finally {
      release();
    }
  }
}

function setup(fullSchema = false) {
  const db = new SqliteD1(fullSchema);
  let clock = 1_000_000;
  const now = () => new Date(clock).toISOString();
  const auths = new Map<AppRole, AuthContext>();
  for (const role of ["owner", "ops", "sales", "accounting", "production", "field"] as const) {
    const id = `appu_test_${role}`;
    db.raw
      .prepare(
        `INSERT INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'seed', ?, ?)`,
      )
      .run(
        id,
        TENANT,
        `${role}@example.invalid`,
        role,
        ["owner", "ops", "field"].includes(role) ? role : "ops",
        role,
        `${role}@example.invalid`,
        now(),
        now(),
      );
    db.raw
      .prepare(
        `INSERT INTO app_sessions (session_hash,user_id,tenant_id,created_at,expires_at,last_seen_at,created_ip_hash,created_user_agent_hash)
      VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(hash(role), id, TENANT, now(), new Date(clock + 3_600_000).toISOString(), now(), hash("ip"), hash("ua"));
    auths.set(role, {
      session: {
        user_id: id,
        tenant_id: TENANT,
        role,
        session_hash: hash(role),
        session_created_at: now(),
        session_expires_at: new Date(clock + 3_600_000).toISOString(),
        email_normalized: `${role}@example.invalid`,
        display_name: role,
        frappe_user_id: `${role}@example.invalid`,
        active: 1,
        created_by: "seed",
        created_at: now(),
        updated_at: now(),
        revoked_at: null,
        device_id: null,
        device_proof_hash: null,
      },
      rawSessionToken: "synthetic-person-session",
      csrfToken: "synthetic-csrf",
      permissions: [],
    });
  }
  const env = { DB: db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN };
  const parseResponse = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as any,
  });
  const app = (path: string, body?: unknown, role: AppRole = "owner", key = "request-0001", csrf = "synthetic-csrf") =>
    parse(handleAgentTeamAppRouteRequest(path, body, role, key, csrf));
  async function handleAgentTeamAppRouteRequest(path: string, body: unknown, role: AppRole, key: string, csrf: string) {
    return await handleAgentTeamAppRoute(
      new Request(`https://bus.example.invalid/api/v1/agent-team${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrf,
          "idempotency-key": key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      auths.get(role)!,
      () => clock,
    );
  }
  // Keep the real host client on its bearer surface; it cannot acquire a person's CSRF/session.
  const worker = new WorkerClient({
    baseUrl: "https://bus.example.invalid",
    token: TOKEN,
    timeoutMs: 1000,
    fetch: async (input, init) => await handleAgentHostApi(new Request(String(input), init), env, () => clock),
  });
  let sequence = 0;
  const run = async (specialist = "lead_concierge") => {
    const signal = await appendSignal(
      db,
      TENANT,
      {
        kind: "event",
        specialist_id: specialist,
        watch_id: null,
        source: "synthetic-test",
        subject: { aggregate: "lead", id: "synthetic-lead" },
        content: { text: "Untrusted customer request" },
        dedupe_key: `signal:${++sequence}`,
      },
      now(),
    );
    assert.ok("signal_id" in signal);
    const opened = await worker.openRun({
      signal_id: signal.signal_id,
      specialist_id: specialist,
      host_run_key: `host-run-${sequence}`,
    });
    return { ...opened, signal_id: signal.signal_id };
  };
  const propose = async (run: { run_id: string; signal_id: string }, action_id: string, args: unknown) => {
    const step = {
      action_id,
      args,
      citations: [{ fact_id: `signal/${run.signal_id}`, version: 1 }],
    };
    const request = { ...step, step_key: hash(canonicalJson(step)) };
    const response = await handleAgentHostApi(
      new Request(`https://bus.example.invalid/api/v1/agents/runs/${run.run_id}/steps`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      }),
      env,
      () => clock,
    );
    return { ...(await parseResponse(response)), request };
  };
  const scalar = (sql: string, ...values: Array<string | number | null>) =>
    db.raw.prepare(sql).get(...values) as Record<string, any>;
  const close = (runId: string, body: unknown) =>
    parse(
      handleAgentHostApi(
        new Request(`https://bus.example.invalid/api/v1/agents/runs/${runId}/close`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        env,
        () => clock,
      ),
    );
  return {
    close,
    db,
    app,
    worker,
    run,
    propose,
    scalar,
    now,
    auths,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const ceiling = {
  count: { max: 2, per: "hour" },
  amount: null,
  recipients: null,
};
const setting = (overrides: Record<string, unknown> = {}) => ({
  action_id: "note.add",
  setting: "within_limits",
  ceiling,
  reason: "Owner confirmed the bounded annotation policy",
  expected_revision: 0,
  ...overrides,
});
const control = (overrides: Record<string, unknown> = {}) => ({
  paused: false,
  clear_hold: false,
  reason: "Owner reviewed the specialist",
  expected_revision: 0,
  ...overrides,
});
const note = {
  object: { aggregate: "lead", id: "synthetic-lead", version: 1 },
  text: "Customer request is unverified.",
};

// parse() accepts a Response promise so route calls always complete before their body is read.
async function parse(response: Promise<Response>) {
  const r = await response;
  return { status: r.status, body: (await r.json()) as any };
}

test("only a fresh owner's active session with CSRF can change delegation; agent fields grant nothing", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting(), "ops")).status, 403);
  assert.equal(
    (await s.app("/specialists/lead_concierge/delegation", setting(), "owner", "request-0001", "wrong")).body.error,
    "csrf_failed",
  );
  assert.equal(
    (
      await s.app("/specialists/lead_concierge/delegation", {
        ...setting(),
        approved_by: "owner",
      })
    ).status,
    400,
  );
  s.tick(5 * 60_000 + 1);
  assert.equal(
    (await s.app("/specialists/lead_concierge/delegation", setting())).body.error,
    "fresh_owner_session_required",
  );
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_delegation_settings").n, 0);
  const hostRequest = await handleAgentHostApi(
    new Request("https://bus.example.invalid/api/v1/agents/specialists/lead_concierge/delegation", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(setting()),
    }),
    { DB: s.db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN },
  );
  assert.equal(hostRequest.status, 404);
});

test("revocation or a role change after route authentication fails inside the atomic write", async () => {
  for (const revoke of [true, false]) {
    const s = setup();
    s.db.beforeBatch = () =>
      s.db.raw.exec(
        revoke
          ? `UPDATE app_sessions SET revoked_at=created_at WHERE user_id='appu_test_owner'`
          : `UPDATE app_users SET active=0 WHERE user_id='appu_test_owner'`,
      );
    assert.equal((await s.app("/specialists/lead_concierge/delegation", setting())).status, 403);
    assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_delegation_settings").n, 0);
  }
});

test("delegation is exact-replay idempotent, rejects aliasing and races one expected revision", async () => {
  const s = setup();
  const path = "/specialists/lead_concierge/delegation";
  const first = await s.app(path, setting());
  assert.equal(first.status, 200);
  assert.deepEqual((await s.app(path, setting())).body, first.body);
  assert.equal(
    (await s.app(path, setting({ ceiling: { ...ceiling, count: { max: 3, per: "hour" } } }))).body.error,
    "idempotency_conflict",
  );
  const results = await Promise.all([
    s.app(path, setting({ expected_revision: 1, setting: "asks_first", ceiling: null }), "owner", "change-0001"),
    s.app(path, setting({ expected_revision: 1, setting: "off", ceiling: null }), "owner", "change-0002"),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_delegation_settings").n, 2);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_control_guard").n, 0);
});

test("H, protective and never-delegable actions cannot receive owner delegation", async () => {
  const s = setup();
  for (const [specialist, action] of [
    ["field_safety", "safety_stop.release"],
    ["billing_reconciliation", "payee.unfreeze"],
    ["proposal_contract", "portal_link.revoke"],
    ["quality_inspector", "ncr.verify_close"],
  ] as const) {
    const r = await s.app(`/specialists/${specialist}/delegation`, setting({ action_id: action }));
    assert.equal(r.status, 422, action);
    assert.ok(["not_delegable", "unknown_action"].includes(r.body.error), action);
  }
  assert.equal(
    (await s.app("/specialists/lead_concierge/delegation", setting({ ceiling: null }))).body.error,
    "ceiling_required",
  );
});

test("auditor holds execute once, cannot target the auditor, and clearing requires per-action reconfirmation", async () => {
  const s = setup();
  const delegated = await s.app("/specialists/lead_concierge/delegation", setting());
  assert.equal(delegated.status, 200);
  const auditor = await s.run("independent_auditor");
  const held = await s.propose(auditor, "specialist.hold", {
    specialist_id: "lead_concierge",
    reason: "Review the unverified source",
  });
  assert.equal(held.body.receipt.outcome, "succeeded");
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).held, true);
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "asks_first");
  const forbidden = await s.propose(auditor, "specialist.hold", {
    specialist_id: "independent_auditor",
    reason: "Try to silence audit",
  });
  assert.notEqual(forbidden.body.receipt.outcome, "succeeded");
  assert.equal((await specialistControl(s.db, TENANT, "independent_auditor")).held, false);
  assert.equal(
    (
      await s.app(
        "/specialists/lead_concierge/delegation",
        setting({ expected_revision: 1 }),
        "owner",
        "held-setting-1",
      )
    ).body.error,
    "specialist_held",
  );
  assert.equal(
    (
      await s.app(
        "/specialists/lead_concierge/control",
        control({ clear_hold: true, expected_revision: 1 }),
        "owner",
        "clear-hold-0001",
      )
    ).status,
    200,
  );
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "asks_first");
  const replay = await s.propose(auditor, "specialist.hold", {
    specialist_id: "lead_concierge",
    reason: "Review the unverified source",
  });
  assert.equal(replay.body.step_id, held.body.step_id);
  assert.equal(
    (await specialistControl(s.db, TENANT, "lead_concierge")).held,
    false,
    "an old step cannot reapply a cleared hold",
  );
  assert.equal(
    (
      await s.app(
        "/specialists/lead_concierge/delegation",
        setting({ expected_revision: 1 }),
        "owner",
        "reconfirm-0001",
      )
    ).status,
    200,
  );
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "within_limits");
});

test("parallel hold replay has one effect and one immutable receipt", async () => {
  const s = setup();
  const run = await s.run("independent_auditor");
  const args = { specialist_id: "estimator", reason: "Check source freshness" };
  const results = await Promise.all([s.propose(run, "specialist.hold", args), s.propose(run, "specialist.hold", args)]);
  assert.equal(results[0].body.step_id, results[1].body.step_id);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_specialist_controls WHERE specialist_id='estimator'").n, 1);
});

test("revocation and pause cancel issued unexecuted delegated permits without faking execution", async () => {
  for (const pause of [true, false]) {
    const s = setup();
    const delegated = await s.app("/specialists/lead_concierge/delegation", setting());
    const run = await s.run();
    const step = await s.propose(run, "note.add", note);
    // Synthetic issued permit fixture: this adapter remains unproven in production source.
    s.db.raw.prepare("UPDATE agent_run_steps SET permit_json=? WHERE step_id=?").run(
      canonicalJson({
        kind: "within_limits",
        delegation_id: delegated.body.setting_id,
      }),
      step.body.step_id,
    );
    const change = pause
      ? s.app("/specialists/lead_concierge/control", control({ paused: true }), "owner", "pause-0001")
      : s.app(
          "/specialists/lead_concierge/delegation",
          setting({ setting: "off", ceiling: null, expected_revision: 1 }),
          "owner",
          "revoke-0001",
        );
    assert.equal((await change).status, 200);
    const stored = s.scalar(
      "SELECT outcome,reason_code,tool_json FROM agent_run_steps WHERE step_id=?",
      step.body.step_id,
    );
    assert.deepEqual({ ...stored }, { outcome: "failed", reason_code: "superseded", tool_json: null });
  }
});

test("unknown or mismatched delegated readback falls back to asks-first until reconfirmed", async () => {
  for (const reason of ["no_readback_yet", "readback_mismatch"]) {
    const s = setup();
    const delegated = await s.app("/specialists/lead_concierge/delegation", setting());
    const step = await s.propose(await s.run(), "note.add", note);
    s.db.raw.prepare("UPDATE agent_run_steps SET permit_json=?,outcome=?,reason_code=? WHERE step_id=?").run(
      canonicalJson({
        kind: "within_limits",
        delegation_id: delegated.body.setting_id,
      }),
      reason === "no_readback_yet" ? "unknown" : "failed",
      reason,
      step.body.step_id,
    );
    const current = await currentDelegation(s.db, TENANT, "lead_concierge", "note.add");
    assert.equal(current?.setting, "asks_first");
    assert.equal(current?.fallback, true);
  }
});

test("human decisions bind the exact step, version, hash, reviewer and replay key", async () => {
  const s = setup();
  const run = await s.run();
  const step = await s.propose(run, "note.add", note);
  const path = `/steps/${step.body.step_id}/decision`;
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  const request = {
    decision: "decline",
    expected_version: row.version,
    expected_args_sha256: row.args_sha256,
  };
  assert.equal((await s.app(path, request, "field")).status, 403);
  assert.equal((await s.app(path, { ...request, expected_args_sha256: "0".repeat(64) })).status, 409);
  assert.equal((await s.app(path, { ...request, approved_by: "owner" })).status, 400);
  const decided = await s.app(path, request, "sales");
  assert.equal(decided.status, 200);
  assert.equal(decided.body.outcome, "failed");
  assert.deepEqual((await s.app(path, request, "sales")).body, decided.body);
  assert.equal((await s.app(path, { ...request, decision: "approve" }, "sales")).body.error, "idempotency_conflict");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 1);
});

test("approval is recorded but an unbound effect remains policy_missing with no tool/readback success", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  const response = await s.app(`/steps/${step.body.step_id}/decision`, {
    decision: "approve",
    expected_version: row.version,
    expected_args_sha256: row.args_sha256,
  });
  assert.deepEqual(response.body, {
    outcome: "abstained",
    reason_code: "policy_missing",
  });
  const stored = s.scalar(
    "SELECT outcome,tool_json,readback_json,permit_json FROM agent_run_steps WHERE step_id=?",
    step.body.step_id,
  );
  assert.equal(stored.tool_json, null);
  assert.equal(stored.readback_json, null);
  assert.equal(JSON.parse(stored.permit_json).approved_by, "appu_test_owner");
});

test("a stale decision transaction rolls back its decision row and permits", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  s.db.beforeBatch = () =>
    s.db.raw.prepare("UPDATE agent_run_steps SET version=version+1 WHERE step_id=?").run(step.body.step_id);
  const response = await s.app(`/steps/${step.body.step_id}/decision`, {
    decision: "approve",
    expected_version: row.version,
    expected_args_sha256: row.args_sha256,
  });
  assert.equal(response.status, 409);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 0);
  assert.equal(s.scalar("SELECT outcome FROM agent_run_steps WHERE step_id=?", step.body.step_id).outcome, null);
});

test("host OAuth-refresh alerts reach one named owner exception; acknowledgement and recurrence are explicit", async () => {
  const s = setup();
  const beat = {
    host_id: "synthetic-host",
    version: "test",
    ready: false,
    alerts: ["codex_signin_not_refreshing"],
    providers: {},
    in_flight: 0,
    backlog: {
      pending_closes: 0,
      oldest_pending_ms: null,
      rejected_closes: 0,
      rejected_signals: 0,
    },
  };
  await Promise.all([s.worker.heartbeat(beat), s.worker.heartbeat(beat)]);
  let list = await s.app("/exceptions");
  assert.equal(list.body.exceptions.length, 1);
  const exception = list.body.exceptions[0];
  assert.equal(exception.assigned_user_id, "appu_test_owner");
  assert.equal(exception.urgency, "immediate");
  assert.equal((await s.app(`/exceptions/${exception.exception_id}/acknowledge`, {}, "sales")).status, 403);
  assert.equal((await s.app(`/exceptions/${exception.exception_id}/acknowledge`, {})).status, 200);
  s.tick(1);
  await s.worker.heartbeat(beat);
  list = await s.app("/exceptions");
  assert.equal(list.body.exceptions.length, 1);
  assert.notEqual(list.body.exceptions[0].exception_id, exception.exception_id);
});

test("a protective escalation uses canonical routing, owned readback and a named person's acknowledgement", async () => {
  const s = setup();
  const args = {
    object: null,
    summary: "The source needs a person",
    reason_code: "fact_missing",
    urgency: "today",
    route_to: "sales",
  };
  const step = await s.propose(await s.run(), "exception.escalate", args);
  assert.equal(step.body.decision, "escalated");
  assert.equal(step.body.receipt.outcome, null);
  const readback = step.body.receipt.readback;
  assert.equal(readback.matched, true);
  const versionBefore = s.scalar("SELECT version FROM agent_run_steps WHERE step_id=?", step.body.step_id).version;
  const replay = await s.propose(
    {
      run_id: step.body.receipt.run_id,
      signal_id: step.request.citations[0].fact_id.slice(7),
    },
    "exception.escalate",
    args,
  );
  assert.equal(replay.body.step_id, step.body.step_id);
  assert.equal(
    s.scalar("SELECT version FROM agent_run_steps WHERE step_id=?", step.body.step_id).version,
    versionBefore,
  );

  const exception = s.scalar("SELECT assigned_user_id FROM agent_exceptions WHERE exception_id=?", readback.reference);
  assert.equal(exception.assigned_user_id, "appu_test_sales");
  assert.equal((await s.app(`/exceptions/${readback.reference}/acknowledge`, {}, "sales")).status, 200);
  assert.equal(s.scalar("SELECT outcome FROM agent_run_steps WHERE step_id=?", step.body.step_id).outcome, "succeeded");
});

test("simultaneous identical owner requests replay the same setting and decision", async () => {
  const s = setup();
  const path = "/specialists/lead_concierge/delegation";
  const settings = await Promise.all([s.app(path, setting()), s.app(path, setting())]);
  assert.deepEqual(
    settings.map((value) => value.status),
    [200, 200],
  );
  assert.equal(settings[0].body.setting_id, settings[1].body.setting_id);
  const step = await s.propose(await s.run(), "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  const request = {
    decision: "decline",
    expected_version: row.version,
    expected_args_sha256: row.args_sha256,
  };
  const decisions = await Promise.all([
    s.app(`/steps/${step.body.step_id}/decision`, request, "owner", "decision-replay-1"),
    s.app(`/steps/${step.body.step_id}/decision`, request, "owner", "decision-replay-1"),
  ]);
  assert.deepEqual(
    decisions.map((value) => value.status),
    [200, 200],
  );
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 1);
});

test("racing approve and decline record only the winning exact decision", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  const request = {
    expected_version: row.version,
    expected_args_sha256: row.args_sha256,
  };
  const decisions = await Promise.all([
    s.app(`/steps/${step.body.step_id}/decision`, { ...request, decision: "approve" }, "owner", "decision-race-1"),
    s.app(`/steps/${step.body.step_id}/decision`, { ...request, decision: "decline" }, "owner", "decision-race-2"),
  ]);
  assert.deepEqual(decisions.map((value) => value.status).sort(), [200, 409]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 1);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_control_guard").n, 0);
});

test("paging accepts explicit unknown canonical IDs but remains unavailable without its provider readback", async () => {
  const s = setup();
  const run = await s.run();
  const args = {
    route_to: "ops",
    urgency: "immediate",
    summary: "Synthetic safety report",
    location: "Caller location is unknown",
    job_id: null,
    contact_id: null,
  };
  const unavailable = await s.propose(run, "emergency.page", args);
  assert.deepEqual(unavailable.body.reason_codes, ["policy_missing"]);
  assert.equal(unavailable.body.receipt.tool, null);
  const alias = await s.propose(run, "emergency.page", {
    ...args,
    lead_id: "fabricated",
  });
  assert.deepEqual(alias.body.reason_codes, ["action_unregistered"]);
  assert.equal(
    run.tools.some((tool) => tool.action_id === "emergency.page"),
    false,
  );
});

test("the authenticated app router reaches the owner control without exposing it on the host bearer surface", async () => {
  const s = setup();
  const { handleAuthenticatedRoute } = await import("../src/app-api.ts");
  const created = new Date().toISOString();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  s.db.raw
    .prepare("UPDATE app_sessions SET created_at=?,expires_at=?,last_seen_at=? WHERE user_id='appu_test_owner'")
    .run(created, expires, created);
  const auth = s.auths.get("owner")!;
  auth.session.session_created_at = created;
  auth.session.session_expires_at = expires;
  const response = await handleAuthenticatedRoute(
    new Request("https://bus.example.invalid/api/v1/agent-team/specialists/lead_concierge/delegation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": auth.csrfToken,
        "idempotency-key": "router-control-1",
      },
      body: JSON.stringify(setting()),
    }),
    { DB: s.db, APP_TENANT_ID: TENANT } as any,
    auth,
  );
  assert.equal(response.status, 200);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_delegation_settings").n, 1);
});

test("the named reviewer can inspect the exact proposal while another role cannot read or decide it", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const detail = await s.app(`/steps/${step.body.step_id}`, undefined, "sales");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.args, note);
  assert.equal(detail.body.version, 1);
  assert.match(detail.body.args_sha256, /^[0-9a-f]{64}$/);
  const queue = await s.app("/receipts", undefined, "sales");
  assert.equal(queue.body.receipts[0].step_id, step.body.step_id);
  assert.equal(queue.body.receipts[0].args_sha256, detail.body.args_sha256);
  assert.equal((await s.app(`/steps/${step.body.step_id}`, undefined, "accounting")).status, 403);
  assert.equal((await s.app("/receipts", undefined, "accounting")).body.receipts.length, 0);
  assert.equal(
    (
      await s.app(
        `/steps/${step.body.step_id}/decision`,
        {
          decision: "do_it_myself",
          expected_version: detail.body.version,
          expected_args_sha256: detail.body.args_sha256,
        },
        "sales",
        "reviewed-step-1",
      )
    ).status,
    200,
  );
});

test("an assigned person's later role change removes proposal access and decision authority", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const detail = await s.app(`/steps/${step.body.step_id}`, undefined, "sales");
  s.db.raw.prepare("UPDATE app_users SET access_role='field' WHERE user_id='appu_test_sales'").run();
  s.auths.get("sales")!.session.role = "field";
  assert.equal((await s.app(`/steps/${step.body.step_id}`, undefined, "sales")).status, 403);
  assert.equal((await s.app("/receipts", undefined, "sales")).body.receipts.length, 0);
  const request = {
    decision: "approve",
    expected_version: detail.body.version,
    expected_args_sha256: detail.body.args_sha256,
  };
  assert.equal((await s.app(`/steps/${step.body.step_id}/decision`, request, "sales")).status, 403);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 0);
});

test("an old policy cannot be approved, while an exact human decline can still close the proposal", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  // An immutable prior run records the policy that was in force when it opened.
  // Simulate its old pinned policy without weakening the production immutability trigger.
  const run = s.scalar("SELECT run_id FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  s.db.raw.exec("DROP TRIGGER prevent_agent_run_identity_update");
  s.db.raw
    .prepare("UPDATE agent_runs SET policy_version='ironwrap.agent_step_policy@previous' WHERE run_id=?")
    .run(run.run_id);
  const detail = await s.app(`/steps/${step.body.step_id}`);
  const request = {
    decision: "approve",
    expected_version: detail.body.version,
    expected_args_sha256: detail.body.args_sha256,
  };
  assert.equal((await s.app(`/steps/${step.body.step_id}/decision`, request)).body.error, "policy_changed");
  assert.equal(
    (
      await s.app(
        `/steps/${step.body.step_id}/decision`,
        { ...request, decision: "decline" },
        "owner",
        "stale-decline-1",
      )
    ).status,
    200,
  );
});

test("acknowledgement racing exception readback never creates a success without its evidence", async () => {
  const s = setup();
  s.db.afterExceptionInsert = async () => {
    const row = s.scalar("SELECT exception_id,step_id FROM agent_exceptions LIMIT 1");
    assert.equal((await s.app(`/exceptions/${row.exception_id}/acknowledge`, {}, "sales")).status, 200);
    assert.equal(
      s.scalar("SELECT outcome FROM agent_run_steps WHERE step_id=?", row.step_id).outcome,
      null,
      "the acknowledgement cannot finalize a step before the owned readback is recorded",
    );
  };
  const step = await s.propose(await s.run(), "exception.escalate", {
    object: null,
    summary: "A person needs to inspect this source",
    reason_code: "fact_missing",
    urgency: "today",
    route_to: "sales",
  });
  assert.equal(step.body.receipt.outcome, "succeeded");
  assert.equal(step.body.receipt.readback.matched, true);
  assert.equal(step.body.receipt.tool.binding, "agent_exceptions");
});

const syntheticHandoff = {
  to_specialist_id: "estimator",
  object: { aggregate: "lead", id: "synthetic-lead", version: 1 },
  reason: "Synthetic coordination request",
  expected_action_id: "fact.explain",
};

test("an owner pause committed after policy read wins before handoff admission", async () => {
  const s = setup(true);
  const run = await s.run();
  s.db.beforeBatch = async () => {
    const paused = await s.app(
      "/specialists/lead_concierge/control",
      control({ paused: true }),
      "owner",
      "racing-pause",
    );
    assert.equal(paused.status, 200);
  };
  const result = await s.propose(run, "handoff.create", syntheticHandoff);
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).paused, true);
  // The owner's own pause decided it: failed, and nobody is handed a task for it.
  assert.equal(result.body.outcome, "failed");
  assert.deepEqual(result.body.reason_codes, ["superseded"]);
  assert.equal(result.body.receipt.permit.kind, "none");
  assert.equal(s.scalar("SELECT needs_reviewer_role r, needs_person_id p FROM agent_run_steps WHERE step_id=?", result.body.step_id).r, null);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_signals WHERE kind='handoff'").n, 0);
  const replay = await s.propose(run, "handoff.create", syntheticHandoff);
  assert.equal(replay.body.step_id, result.body.step_id);
  assert.equal(replay.body.outcome, "failed");
});

test("an auditor hold committed before admission stops the old handoff and requires review of new proposals", async () => {
  const s = setup(true);
  const run = await s.run();
  const auditor = await s.run("independent_auditor");
  s.db.beforeBatch = async () => {
    const held = await s.propose(auditor, "specialist.hold", {
      specialist_id: "lead_concierge",
      reason: "Synthetic evidence review",
    });
    assert.equal(held.body.outcome, "succeeded");
  };
  const result = await s.propose(run, "handoff.create", syntheticHandoff);
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).held, true);
  assert.deepEqual(result.body.reason_codes, ["superseded"]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_signals WHERE kind='handoff'").n, 0);
  const next = await s.propose(run, "handoff.create", {
    ...syntheticHandoff,
    reason: "Synthetic new proposal under hold",
  });
  assert.equal(next.body.outcome, null);
  assert.equal(next.body.receipt.policy.result, "needs_approval");
  assert.equal(next.body.receipt.permit.kind, "asks_first");
  const read = await s.propose(run, "fact.explain", { object: null, explanation: "Synthetic held read proposal" });
  assert.equal(read.body.receipt.policy.result, "needs_approval");
  assert.equal(read.body.receipt.permit.kind, "asks_first");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_signals WHERE kind='handoff'").n, 0);
});

test("a delegation revocation committed after policy read cannot issue the old permit", async () => {
  const s = setup(true);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting())).status, 200);
  const run = await s.run();
  s.db.beforeStepInsert = async () => {
    const revoked = await s.app(
      "/specialists/lead_concierge/delegation",
      setting({ setting: "off", ceiling: null, expected_revision: 1 }),
      "owner",
      "racing-revoke",
    );
    assert.equal(revoked.status, 200);
  };
  const result = await s.propose(run, "note.add", note);
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "off");
  assert.equal(result.body.outcome, "failed");
  assert.deepEqual(result.body.reason_codes, ["superseded"]);
  assert.equal(result.body.receipt.permit.kind, "none");
  assert.equal(result.body.receipt.tool, null);
  assert.equal(result.body.receipt.readback, null);
  assert.equal(s.scalar("SELECT needs_reviewer_role r FROM agent_run_steps WHERE step_id=?", result.body.step_id).r, null);
  const held = await s.propose(await s.run("independent_auditor"), "specialist.hold", {
    specialist_id: "lead_concierge",
    reason: "Synthetic review after revocation",
  });
  assert.equal(held.body.outcome, "succeeded");
  const stillOff = await s.propose(run, "note.add", {
    ...note,
    text: "Synthetic fresh proposal after revoke and hold",
  });
  assert.equal(stillOff.body.outcome, "failed");
  assert.deepEqual(stillOff.body.reason_codes, ["policy_denied"]);
  assert.equal(stillOff.body.receipt.permit.kind, "none");
});

test("replacement inserts cannot clear holds or rewrite any protected control identity", async () => {
  const s = setup(true);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting())).status, 200);
  const run = await s.run();
  const proposal = await s.propose(run, "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", proposal.body.step_id);
  assert.equal(
    (
      await s.app(
        `/steps/${proposal.body.step_id}/decision`,
        {
          decision: "decline",
          expected_version: row.version,
          expected_args_sha256: row.args_sha256,
        },
        "owner",
        "seed-decision",
      )
    ).status,
    200,
  );
  const held = await s.propose(await s.run("independent_auditor"), "specialist.hold", {
    specialist_id: "lead_concierge",
    reason: "Synthetic hold",
  });
  assert.equal(held.body.outcome, "succeeded");
  const exception = await s.propose(run, "exception.escalate", {
    object: null,
    summary: "Synthetic exception",
    reason_code: "fact_missing",
    urgency: "brief",
    route_to: "owner",
  });
  assert.equal(exception.status, 200);
  assert.equal(s.scalar("PRAGMA recursive_triggers").recursive_triggers, 0);
  const cases = [
    {
      table: "agent_delegation_settings",
      unique: [
        ["setting_id"],
        ["tenant_id", "specialist_id", "action_id", "revision"],
        ["tenant_id", "idempotency_key"],
      ],
      changed: "reason",
      error: /agent_delegation_settings_append_only/,
    },
    {
      table: "agent_specialist_controls",
      unique: [
        ["control_id"],
        ["tenant_id", "idempotency_key"],
        ["tenant_id", "hold_step_id"],
        ["tenant_id", "specialist_id", "revision"],
      ],
      changed: "held",
      error: /agent_specialist_controls_append_only/,
    },
    {
      table: "agent_step_decisions",
      unique: [["decision_id"], ["step_id"], ["tenant_id", "idempotency_key"]],
      changed: "decision",
      error: /agent_step_decisions_append_only/,
    },
    {
      table: "agent_exceptions",
      unique: [["exception_id"], ["tenant_id", "dedupe_key"]],
      changed: "summary",
      error: /agent_exception_immutable/,
    },
  ];
  for (const item of cases) {
    const original = s.scalar(`SELECT * FROM ${item.table} LIMIT 1`);
    assert.ok(original);
    const columns = Object.keys(original);
    for (const conflict of item.unique) {
      const replacement = {
        ...original,
        [item.changed]: item.changed === "held" ? 0 : item.changed === "decision" ? "approve" : "Synthetic replacement",
      };
      for (const fields of item.unique)
        for (const key of fields) {
          if (conflict.includes(key) || ["tenant_id", "specialist_id", "action_id"].includes(key)) continue;
          replacement[key] = typeof original[key] === "number" ? original[key] + 1000 : `different-${original[key]}`;
        }
      assert.throws(
        () =>
          s.db.raw
            .prepare(
              `INSERT OR REPLACE INTO ${item.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
            )
            .run(...columns.map((c) => replacement[c])),
        item.error,
        `${item.table} ${conflict.join("+")}`,
      );
      assert.deepEqual(s.scalar(`SELECT * FROM ${item.table} LIMIT 1`), original);
    }
  }
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).held, true);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_control_guard").n, 0);
});

test("concurrent protective escalation replay retains one exception and its owned readback", async () => {
  const s = setup(true);
  const run = await s.run();
  const args = {
    object: null,
    summary: "Synthetic parallel exception",
    reason_code: "fact_missing",
    urgency: "brief",
    route_to: "owner",
  };
  const results = await Promise.all([
    s.propose(run, "exception.escalate", args),
    s.propose(run, "exception.escalate", args),
  ]);
  assert.ok(results.every((r) => r.status === 200 && r.body.receipt.readback?.matched === true));
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_exceptions").n, 1);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_run_steps WHERE run_id=?", run.run_id).n, 1);
});

for (const order of ["active", "paused", "held", "pause_then_hold", "hold_then_pause"] as const) {
  test(`independent controls require review of non-protective proposals: ${order}`, async () => {
    const s = setup(true);
    assert.equal(
      (await s.app("/specialists/lead_concierge/delegation", setting(), "owner", "matrix-setting")).status,
      200,
    );
    const pause = async () => {
      const current = await specialistControl(s.db, TENANT, "lead_concierge");
      assert.equal(
        (
          await s.app(
            "/specialists/lead_concierge/control",
            control({ paused: true, expected_revision: current.revision }),
            "owner",
            "matrix-pause",
          )
        ).status,
        200,
      );
    };
    const hold = async () => {
      const result = await s.propose(await s.run("independent_auditor"), "specialist.hold", {
        specialist_id: "lead_concierge",
        reason: "Synthetic matrix hold",
      });
      assert.equal(result.body.outcome, "succeeded");
    };
    if (order === "paused" || order === "pause_then_hold") await pause();
    if (order === "held" || order === "pause_then_hold" || order === "hold_then_pause") await hold();
    if (order === "hold_then_pause") await pause();
    const flags = {
      paused: order.includes("pause") || order === "paused",
      held: order.includes("hold") || order === "held",
    };
    const overview = await s.app("/specialists/lead_concierge");
    assert.equal(overview.body.control.paused, flags.paused);
    assert.equal(overview.body.control.held, flags.held);
    assert.equal(overview.body.control.revision, order.includes("_then_") ? 2 : order === "active" ? 0 : 1);
    const run = await s.run();
    const review = flags.paused || flags.held;
    for (const [action, args] of [
      ["fact.explain", { object: null, explanation: "Synthetic control matrix read" }],
      ["handoff.create", syntheticHandoff],
    ] as const) {
      const result = await s.propose(run, action, args);
      assert.equal(result.body.receipt.policy.result, review ? "needs_approval" : "allow");
      assert.equal(result.body.receipt.permit.kind, review ? "asks_first" : "none");
      assert.equal(result.body.outcome, review ? null : "succeeded");
      assert.equal((await s.propose(run, action, args)).body.step_id, result.body.step_id);
    }
    assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_signals WHERE kind='handoff'").n, review ? 0 : 1);
    const unproven = await s.propose(run, "note.add", note);
    assert.equal(unproven.body.receipt.policy.result, "needs_approval");
    assert.equal(unproven.body.receipt.permit.kind, "asks_first");
    assert.equal(
      (
        await s.app(
          "/specialists/lead_concierge/delegation",
          setting({ setting: "off", ceiling: null, expected_revision: 1 }),
          "owner",
          "matrix-revoke",
        )
      ).status,
      200,
    );
    const off = await s.propose(run, "note.add", { ...note, text: "Synthetic revoked matrix proposal" });
    assert.equal(off.body.receipt.policy.result, "deny");
    assert.equal(off.body.receipt.permit.kind, "none");
    const human = await s.propose(run, "delegation.set", {});
    assert.equal(human.body.receipt.policy.result, "deny");
    assert.equal(human.body.receipt.permit.kind, "none");
    const protective = await s.propose(run, "exception.escalate", {
      object: null,
      summary: "Synthetic matrix escalation",
      reason_code: "fact_missing",
      urgency: "brief",
      route_to: "owner",
    });
    assert.equal(protective.body.receipt.policy.result, "allow");
    assert.equal(protective.body.receipt.permit.kind, "within_limits");
    assert.equal(protective.body.receipt.readback.matched, true);
  });
}

test("pausing the auditor keeps protective holds and escalation available", async () => {
  const s = setup(true);
  assert.equal(
    (await s.app("/specialists/independent_auditor/control", control({ paused: true }), "owner", "pause-auditor"))
      .status,
    200,
  );
  const auditor = await s.run("independent_auditor");
  const hold = await s.propose(auditor, "specialist.hold", {
    specialist_id: "lead_concierge",
    reason: "Synthetic paused-auditor protection",
  });
  assert.equal(hold.body.outcome, "succeeded");
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).held, true);
  const exception = await s.propose(auditor, "exception.escalate", {
    object: null,
    summary: "Synthetic paused-auditor escalation",
    reason_code: "fact_missing",
    urgency: "brief",
    route_to: "owner",
  });
  assert.equal(exception.body.receipt.policy.result, "allow");
  assert.equal(exception.body.receipt.readback.matched, true);
});

const DRAFT_OUTPUT = {
  decision: "propose",
  escalate_to: null,
  reason_code: null,
  reason: "Synthetic follow-up drafted.",
  receipts: [],
  drafts: [{ id: "draft-1", audience: "customer", language: "en", text: "Synthetic draft for a person to send." }],
  final_text: "Drafted.",
};
const closeBody = (output: unknown) => ({
  status: "ok",
  reason: null,
  detail: null,
  output,
  model: { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine" },
  hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
  usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
  cost_usd: 0.01,
  attempts: 1,
  duration_ms: 1200,
  tool_calls: [],
});
test("a paused specialist's run closes without its drafts, and the exact retry still replays", async () => {
  const s = setup();
  const run = await s.run();
  assert.equal((await s.app("/specialists/lead_concierge/control", control({ paused: true }))).status, 200);
  const host = (body: unknown) => s.close(run.run_id, body);
  const first = await host(closeBody(DRAFT_OUTPUT));
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const stored = JSON.parse(s.scalar("SELECT close_json c FROM agent_runs WHERE run_id=?", run.run_id).c);
  assert.deepEqual(stored.output.drafts, []);
  assert.deepEqual(stored.withheld, { drafts: 1, reason: "specialist_paused" });
  assert.equal(JSON.stringify(stored).includes("Synthetic draft"), false);
  // The host's byte-identical retry replays instead of a 409 that would skip escalation.
  assert.equal((await host(closeBody(DRAFT_OUTPUT))).status, 200);
  assert.equal((await host(closeBody({ ...DRAFT_OUTPUT, final_text: "Different." }))).status, 409);
});

test("an action switched off after the proposal cannot be approved, but can be declined", async () => {
  const s = setup();
  const step = await s.propose(await s.run(), "note.add", note);
  const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
  assert.equal(
    (await s.app("/specialists/lead_concierge/delegation", setting({ setting: "off", ceiling: null }), "owner", "revoke-before-approve")).status,
    200,
  );
  const decide = (decision: string, key: string) =>
    s.app(`/steps/${step.body.step_id}/decision`, { decision, expected_version: row.version, expected_args_sha256: row.args_sha256 }, "owner", key);
  const approved = await decide("approve", "approve-after-revoke");
  assert.equal(approved.status, 409);
  assert.equal(approved.body.error, "delegation_off");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_step_decisions").n, 0);
  assert.equal((await decide("decline", "decline-after-revoke")).status, 200);
});

test("holding a held specialist adds no revision, and a clear racing it re-applies the hold", async () => {
  const s = setup();
  const auditor = await s.run("independent_auditor");
  const hold = (reason: string) => s.propose(auditor, "specialist.hold", { specialist_id: "lead_concierge", reason });
  assert.equal((await hold("First synthetic review")).body.outcome, "succeeded");
  const second = await hold("Second synthetic review");
  assert.equal(second.body.outcome, "succeeded");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_specialist_controls WHERE specialist_id='lead_concierge'").n, 1);
  // An owner clear that commits between the held read and the no-op makes it a fresh hold.
  s.db.beforeBatch = async () => {
    const cleared = await s.app("/specialists/lead_concierge/control", control({ clear_hold: true, expected_revision: 1 }), "owner", "racing-clear");
    assert.equal(cleared.status, 200);
  };
  const third = await hold("Third synthetic review");
  assert.equal(third.body.outcome, "succeeded");
  assert.equal((await specialistControl(s.db, TENANT, "lead_concierge")).held, true);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_specialist_controls WHERE specialist_id='lead_concierge'").n, 3);
});
