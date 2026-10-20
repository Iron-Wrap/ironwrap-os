import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAgentHostApi, handleAgentTeamAppRoute } from "../src/agents/api.ts";
import { appendSignal, type BoundStatement } from "../src/agents/store.ts";
import { catalogAction, earnable } from "../src/agents/catalog.ts";
import { currentDelegation, specialistControl } from "../src/agents/control.ts";
import { effectiveDelegation } from "../src/agents/policy.ts";
import { CATASTROPHE_IDS, SHADOW_COMPARE_WINDOW_MS, sweepShadow } from "../src/agents/shadow.ts";
import { canonicalJson } from "../src/agents/schema.ts";
import { WATCH_CONDITIONS } from "../src/agents/watches.ts";
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
      : [
          "0001_init.sql",
          "0011_app_bff_auth.sql",
          "0090_operating_core.sql",
          "0200_agent_coordination.sql",
          "0201_agent_delegation.sql",
          "0202_agent_fact_versions.sql",
          "0203_agent_shadow_agreement.sql",
          "0204_agent_watch_firings.sql",
          "0205_agent_step_pair_index.sql",
        ];
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

function setup(fullSchema = false, workerVars: Record<string, string> = {}) {
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
  const env = { DB: db, APP_TENANT_ID: TENANT, AGENT_HOST_TOKEN: TOKEN, ...workerVars };
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
  const run = async (specialist = "lead_concierge", signalOverrides: Partial<Parameters<typeof appendSignal>[2]> = {}) => {
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
        ...signalOverrides,
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

test("the owner's caps keep every outside send and price commitment at asks first", async () => {
  const s = setup();
  // Every send outside IronWrap, every price commitment and every commitment of money to an outside
  // party asks first (D-05, D-09, Q4, L04): the twenty-four actions the catalog caps, with
  // customer_message.send for two of its owners.
  const capped = [
    ["estimator", "quote.commit_revision"],
    ["estimator", "quote.apply_discount"],
    ["estimator", "change_order.commit"],
    ["lead_concierge", "customer_message.send"],
    ["billing_reconciliation", "customer_message.send"],
    ["lead_concierge", "visit.confirm"],
    ["proposal_contract", "portal_link.send"],
    ["proposal_contract", "proposal.publish"],
    ["proposal_contract", "change_order.send_for_decision"],
    ["customer_care_warranty", "remedy.offer"],
    ["marketing_reputation", "campaign.send"],
    ["billing_reconciliation", "invoice.commit_intent"],
    ["marketing_reputation", "review_response.publish"],
    ["estimator", "insurance_supplement.send"],
    ["purchasing_inventory", "rfq.send"],
    ["purchasing_inventory", "purchase_order.place"],
    ["purchasing_inventory", "purchase_order.change"],
    ["purchasing_inventory", "purchase_order.expedite"],
    ["billing_reconciliation", "supplier_message.send"],
    ["purchasing_inventory", "supplier_return.request"],
    ["compliance", "document.request"],
    ["customer_care_warranty", "cost_recovery.claim"],
    ["marketing_reputation", "content.publish"],
    ["marketing_reputation", "ad_spend.commit"],
    ["billing_reconciliation", "supplier_bill.approve"],
  ] as const;
  for (const [specialist, actionId] of capped) {
    const action = catalogAction(actionId);
    assert.ok(action, actionId);
    assert.equal(action.delegable, false, actionId);
    // Never a delegation candidate, so the face never proposes acting within limits for it.
    assert.equal(earnable(action), false, actionId);
    for (const [key, body] of [
      ["within", setting({ action_id: actionId })],
      ["asks", setting({ action_id: actionId, setting: "asks_first", ceiling: null })],
      ["off", setting({ action_id: actionId, setting: "off", ceiling: null })],
    ] as const) {
      const r = await s.app(`/specialists/${specialist}/delegation`, body, "owner", `cap-${key}-${specialist}-${actionId}`);
      assert.equal(r.status, 422, `${actionId} ${key}`);
      assert.equal(r.body.error, "not_delegable", `${actionId} ${key}`);
    }
    // A within-limits setting recorded before the cap no longer applies: the step asks first.
    const before = { delegation_id: "dlg_recorded_before_the_cap", setting: "within_limits" } as const;
    assert.equal(effectiveDelegation(action, { delegation: before, specialistState: { paused: false, held: false } }), "asks_first");
  }
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_delegation_settings").n, 0);
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

test("an approved import retry or lead confirmation runs nothing: the decision is recorded and its reviewer takes the work over", async () => {
  const s = setup();
  const steps = [
    { specialist: "orchestrator", action: "import.retry_failed", args: { import_run_id: "import_run:synthetic-0001", source_keys: ["SRC-0001", "SRC-0002"] }, reviewer: "owner" },
    { specialist: "lead_concierge", action: "lead_fact.confirm", args: { lead_id: "synthetic-lead", proposal_id: "proposal-0001", fields: { service: "metal_roofing", scope: null, address: null, timing: null } }, reviewer: "sales" },
  ];
  for (const item of steps) {
    const proposed = await s.propose(await s.run(item.specialist), item.action, item.args);
    assert.deepEqual(
      [proposed.body.decision, proposed.body.receipt.permit.kind, proposed.body.receipt.needs_from_you?.reviewer_role],
      ["awaiting_approval", "asks_first", item.reviewer],
      item.action,
    );
    const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", proposed.body.step_id);
    const approved = await s.app(`/steps/${proposed.body.step_id}/decision`, { decision: "approve", expected_version: row.version, expected_args_sha256: row.args_sha256 }, "owner", `approve-${item.action}`);
    assert.deepEqual(approved.body, { outcome: "abstained", reason_code: "policy_missing" }, item.action);
    const stored = s.scalar("SELECT tool_json,readback_json,needs_reviewer_role,needs_ask,permit_json FROM agent_run_steps WHERE step_id=?", proposed.body.step_id);
    assert.deepEqual([stored.tool_json, stored.readback_json, stored.needs_reviewer_role, stored.needs_ask], [null, null, item.reviewer, "acknowledge_and_act"], item.action);
    assert.equal(JSON.parse(stored.permit_json).approved_by, "appu_test_owner");
    // The reviewer's Needs you holds it with the ask to take it over, never as done.
    const lane = await s.app("/receipts?view=needs_you");
    const receipt = lane.body.receipts.find((entry: { step_id: string }) => entry.step_id === proposed.body.step_id)?.receipt;
    assert.deepEqual([receipt?.outcome, receipt?.needs_from_you?.ask], ["abstained", "Take this over and act on it."], item.action);
    assert.match(String(receipt?.did), /stopped before/, item.action);
  }
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
const QUALIFIED = { specialist_id: "lead_concierge", provider: "codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: "e".repeat(64) };
/** Closes one run on a model, so the candidate bar knows what the specialist actually runs on. */
async function runsOn(s: ReturnType<typeof setup>, model = "gpt-6.1-sol", provider = "codex") {
  const run = await s.run();
  const body = closeBody({ ...DRAFT_OUTPUT, drafts: [] });
  assert.equal((await s.close(run.run_id, { ...body, model: { ...body.model, provider, model, models_used: [model] } })).status, 200);
}
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

// --- Earned autonomy: shadow, agreement and candidates (migration 0203) ---

const shadowBody = (overrides: Record<string, unknown> = {}) => ({
  action_id: "note.add",
  shadow: true,
  reason: "Owner wants to see the annotations before they count",
  expected_revision: 0,
  ...overrides,
});

test("the Worker's catastrophe ids are Track D's", () => {
  const evals = JSON.parse(readFileSync(new URL("../../agent-host/evals/catastrophes.v1.json", import.meta.url), "utf8")) as { catastrophes: Array<{ id: string }> };
  assert.deepEqual([...CATASTROPHE_IDS], evals.catastrophes.map((entry) => entry.id));
});

test("only a fresh owner session can shadow an action, and only actions with an effect to stand in for", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "ops")).status, 403);
  for (const action_id of ["fact.explain", "exception.escalate", "emergency.page"]) {
    const refused = await s.app("/specialists/lead_concierge/shadow", shadowBody({ action_id }), "owner", `shadow-${action_id.replace(".", "-")}`);
    assert.equal(refused.body.error, "not_shadowable", `${action_id} ${JSON.stringify(refused)}`);
  }
  assert.equal((await s.app("/specialists/estimator/shadow", shadowBody({ action_id: "customer_message.send" }), "owner", "shadow-not-owner")).body.error, "not_shadowable");
  const set = await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-note-1");
  assert.deepEqual([set.status, set.body.revision], [200, 1]);
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-note-1")).body.revision, 1);
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-note-2")).body.error, "stale_version");
  assert.throws(() => s.db.raw.exec("UPDATE agent_shadow_settings SET shadow = 0"), /append_only/);
});

test("a shadowed action is decided but recorded as a shadow step: no receipt, task, permit or handoff", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-note")).status, 200);
  const run = await s.run();
  assert.equal((run as { mode?: string }).mode, "live");
  const shadowed = await s.propose(run, "note.add", note);
  assert.equal(shadowed.status, 200);
  assert.deepEqual([shadowed.body.decision, shadowed.body.outcome, shadowed.body.receipt, shadowed.body.would_be], ["shadowed", null, null, "needs_approval"]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_run_steps WHERE action_id = 'note.add'").n, 0);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_shadow_steps WHERE action_id = 'note.add'").n, 1);
  assert.equal((await s.app("/receipts?view=needs_you")).body.receipts.length, 0);
  // The exact retry is the same shadow step; another action on the run stays live.
  assert.equal((await s.propose(run, "note.add", note)).body.step_id, shadowed.body.step_id);
  const live = await s.propose(run, "fact.explain", { object: null, explanation: "Synthetic explanation." });
  assert.notEqual(live.body.decision, "shadowed");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_run_steps WHERE action_id = 'fact.explain'").n, 1);
  // Protective actions are never diverted, even on a run whose every action is shadowed.
  const handoff = await s.run("lead_concierge", { kind: "handoff", content: { expected_action_id: "note.add", reason: "Synthetic" } });
  assert.deepEqual([(handoff as { mode?: string }).mode, (handoff as { expected_action_id?: string }).expected_action_id], ["shadow", "note.add"]);
  const escalated = await s.propose(handoff, "exception.escalate", { reason_code: "person_requested", summary: "Synthetic escalation", urgency: "today", reviewer_role: "sales" });
  assert.notEqual(escalated.body.decision, "shadowed");
});

test("a person's decision on a proposal is agreement, and a flagged catastrophe demotes within-limits delegation", async () => {
  const s = setup(true);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting())).status, 200);
  const decide = async (decision: string, key: string, extra: Record<string, unknown> = {}) => {
    const step = await s.propose(await s.run(), "note.add", { ...note, text: `Synthetic note ${key}` });
    const row = s.scalar("SELECT version,args_sha256 FROM agent_run_steps WHERE step_id=?", step.body.step_id);
    return await s.app(`/steps/${step.body.step_id}/decision`, { decision, expected_version: row.version, expected_args_sha256: row.args_sha256, ...extra }, "owner", key);
  };
  assert.equal((await decide("approve", "agree-approve")).status, 200);
  assert.equal((await decide("do_it_myself", "agree-myself")).status, 200);
  assert.equal((await decide("approve", "agree-approve-flagged", { catastrophes: ["fabricates_fact"] })).status, 400);
  assert.equal((await decide("decline", "agree-unknown-flag", { catastrophes: ["not_a_catastrophe"] })).status, 400);
  assert.deepEqual(
    s.db.raw.prepare("SELECT verdict, comparator FROM agent_agreements ORDER BY verdict").all().map((row) => ({ ...row })),
    [{ verdict: "match", comparator: "person_decision" }, { verdict: "unscored", comparator: "person_decision" }],
  );
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "within_limits");
  const flagged = await decide("decline", "agree-flagged", { catastrophes: ["fabricates_fact"] });
  assert.equal(flagged.status, 200);
  const demoted = await currentDelegation(s.db, TENANT, "lead_concierge", "note.add");
  assert.equal(demoted?.setting, "asks_first");
  assert.equal(s.scalar("SELECT set_by_user_id u FROM agent_delegation_settings ORDER BY revision DESC LIMIT 1").u, "system:auto_demotion");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_exceptions WHERE dedupe_key LIKE 'catastrophe:%' AND reviewer_role = 'owner'").n, 1);
  const stats = (await s.app("/shadow")).body.agreement;
  assert.deepEqual(stats.map((row: { action_id: string; counts: unknown; catastrophes: number }) => [row.action_id, row.counts, row.catastrophes]), [
    ["note.add", { match: 1, partial: 0, diverge: 1, unscored: 1 }, 1],
  ]);
  // The automatic writer can only move a within-limits setting to asks first.
  const insert = (setting: string, ceilingJson: string | null) =>
    s.db.raw
      .prepare(
        `INSERT INTO agent_delegation_settings (setting_id,tenant_id,specialist_id,action_id,revision,control_revision,catalog_version,policy_version,setting,ceiling_json,reason,set_by_user_id,set_at,idempotency_key)
       VALUES (?, ?, 'lead_concierge', 'note.add', ?, 0, 'v', 'p', ?, ?, 'Synthetic', 'system:auto_demotion', ?, ?)`,
      )
      .run(`dlg_synthetic_${setting}`, TENANT, (demoted?.revision ?? 0) + 1, setting, ceilingJson, s.now(), `synthetic-${setting}`);
  assert.throws(() => insert("asks_first", null), /agent_control_authority/);
  assert.throws(() => insert("within_limits", canonicalJson(ceiling)), /agent_control_authority/);
});

test("shadow steps nobody compares are recorded unscored once their window passes, once", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-sweep")).status, 200);
  await s.propose(await s.run(), "note.add", note);
  assert.deepEqual(await sweepShadow(s.db, TENANT, s.now(), null), { compared: 0, unscored: 0 });
  const later = new Date(Date.parse(s.now()) + SHADOW_COMPARE_WINDOW_MS).toISOString();
  assert.deepEqual(await sweepShadow(s.db, TENANT, later, null), { compared: 0, unscored: 1 });
  assert.deepEqual(await sweepShadow(s.db, TENANT, later, null), { compared: 0, unscored: 0 });
  assert.equal(s.scalar("SELECT verdict v, comparator c FROM agent_agreements").v, "unscored");
});

/**
 * Seeds `count` compared practice decisions of one action on a fresh run of lead_concierge, then
 * closes that run on the qualified v3 route, so they count toward the bar: a run under the current
 * step policy, closed on the specialist's current release.
 */
async function seedCompared(
  s: ReturnType<typeof setup>,
  qualificationId: string | null,
  count: number,
  verdict: string,
  { catastrophes = "[]", action = "note.add", model = {} }: { catastrophes?: string; action?: string; model?: Record<string, unknown> } = {},
) {
  const run = await s.run();
  for (let index = 0; index < count; index += 1) {
    const n = s.scalar("SELECT COUNT(*) n FROM agent_agreements").n + 1;
    const id = `sstep_seed_${n}`;
    s.db.raw
      .prepare(
        `INSERT INTO agent_shadow_steps (shadow_step_id,tenant_id,run_id,specialist_id,action_id,step_key,args_json,args_sha256,sources_json,policy_json,subject_aggregate,subject_id,proposed_at)
        VALUES (?, ?, ?, 'lead_concierge', ?, ?, '{}', ?, '[]', '{}', NULL, NULL, ?)`,
      )
      .run(id, TENANT, run.run_id, action, id, "0".repeat(64), s.now());
    s.db.raw
      .prepare(
        `INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at)
        VALUES (?, ?, 'shadow', 'lead_concierge', ?, ?, NULL, ?, ?, 'synthetic@1', NULL, ?)`,
      )
      .run(`agr_${id}`, TENANT, action, id, verdict, catastrophes, new Date(Date.parse(s.now()) + n).toISOString());
  }
  s.tick(1_000);
  const closed = await s.close(run.run_id, closeV3({ ...model, qualification_ref: qualificationId }));
  // Without a qualification the Worker refuses the close's output; it still records the model block.
  assert.deepEqual([closed.status, closed.body.terminal], [200, qualificationId ? "completed" : "abstained"]);
  return run;
}

test("a delegation candidate needs the recent bar, no catastrophe, a passed qualification and a delegable action", async () => {
  const s = setup(true);
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { specialist_id: string; action_id: string }) => `${row.specialist_id} ${row.action_id}`);
  const qualify = (passed: boolean, key: string) =>
    s.app("/qualifications", { ...QUALIFIED, passed, report_sha256: passed ? "a".repeat(64) : "b".repeat(64) }, "owner", key);
  const passed = await qualify(true, "qualify-1");
  assert.equal(passed.status, 200);
  await seedCompared(s, passed.body.qualification_id, 48, "match");
  await seedCompared(s, passed.body.qualification_id, 1, "diverge", { catastrophes: '["fabricates_fact"]' });
  await seedCompared(s, passed.body.qualification_id, 1, "match");
  // A catastrophe inside the recent window blocks it.
  assert.deepEqual(await candidates(), []);
  // Fifty newer clean comparisons push it out of the window: old wins and old losses both age out.
  await seedCompared(s, passed.body.qualification_id, 50, "match");
  assert.deepEqual(await candidates(), ["lead_concierge note.add"]);
  // A later failed qualification blocks it again; ops cannot record one.
  assert.equal((await s.app("/qualifications", { ...QUALIFIED, passed: false, report_sha256: "b".repeat(64) }, "ops", "qualify-ops")).status, 403);
  s.tick(1_000);
  assert.equal((await qualify(false, "qualify-2")).status, 200);
  assert.deepEqual(await candidates(), []);
});

test("an audit that came back from the reviewed run's own family is not accepted", async () => {
  const s = setup();
  const reviewed = await s.run();
  const close = (output: Record<string, unknown>, provider: string) => ({
    status: "ok",
    reason: null,
    detail: null,
    output,
    model: { provider, model: provider === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5", models_used: [], auth_mode: "chatgpt", tier: "routine" },
    hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    cost_usd: 0.01,
    attempts: 1,
    duration_ms: 10,
    tool_calls: [],
  });
  const output = { decision: "propose", escalate_to: null, reason_code: null, reason: "Synthetic.", receipts: [], drafts: [], final_text: "Done." };
  assert.equal((await s.close(reviewed.run_id, close(output, "codex"))).status, 200);
  const audit = await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewed.run_id } });
  // A legacy close names its provider; the hint adds the family that provider stands for.
  assert.deepEqual((audit as { review_of?: unknown }).review_of, { run_id: reviewed.run_id, provider: "codex", family: "openai" });
  assert.equal((await s.close(audit.run_id, close(output, "codex"))).body.terminal, "abstained");
  const fair = await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewed.run_id } });
  assert.equal((await s.close(fair.run_id, close(output, "claude"))).body.terminal, "completed");
});

test("shadow is a delegation value: setting it shadows the action, any other setting ends shadow", async () => {
  const s = setup();
  const shadowed = await s.app("/specialists/lead_concierge/delegation", setting({ setting: "shadow", ceiling: null, expected_revision: 0 }), "owner", "deleg-shadow-1");
  assert.deepEqual([shadowed.status, shadowed.body.revision], [200, 1]);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting({ setting: "shadow", ceiling, expected_revision: 1 }), "owner", "deleg-shadow-ceiling")).status, 422);
  const overview = (await s.app("/specialists/lead_concierge")).body.actions.find((action: { action_id: string }) => action.action_id === "note.add");
  assert.deepEqual(overview.shadow, { shadow: true, revision: 1, stopped: false });
  // Setting asks first (delegation revision 1) also writes the shadow-off revision in the same write.
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting({ setting: "asks_first", ceiling: null, expected_revision: 0 }), "owner", "deleg-asks-1")).status, 200);
  const after = (await s.app("/specialists/lead_concierge")).body.actions.find((action: { action_id: string }) => action.action_id === "note.add");
  assert.deepEqual([after.shadow, after.setting.setting], [{ shadow: false, revision: 2, stopped: false }, "asks_first"]);
  assert.equal((await s.propose(await s.run(), "note.add", note)).body.decision, "awaiting_approval");
});

test("a host on gateway config v2 closes with its route, review and mode; unknown model fields are still refused", async () => {
  const s = setup();
  const output = { decision: "propose", escalate_to: null, reason_code: null, reason: "Synthetic.", receipts: [], drafts: [], final_text: "Done." };
  const body = (model: Record<string, unknown> | null) => ({
    status: "ok", reason: null, detail: null, output,
    model,
    hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    cost_usd: 0.01, attempts: 1, duration_ms: 10, tool_calls: [],
  });
  const base = { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine" };
  assert.equal((await s.close((await s.run()).run_id, body({ ...base, route_id: "codex_sol", review_of: null, mode: "live" }))).status, 200);
  assert.equal((await s.close((await s.run()).run_id, body({ ...base, route_id: "codex_sol", review_of: null }))).status, 422);
  assert.equal((await s.close((await s.run()).run_id, body({ ...base, extra: true }))).status, 422);
  assert.equal((await s.close((await s.run()).run_id, body(base))).status, 200);
});

// --- R2 review regressions ---

test("a run's shadow mode diverts nothing the owner did not shadow, and is shadow only when every expected action is", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-note-r")).status, 200);
  const handoff = await s.run("lead_concierge", { kind: "handoff", content: { expected_action_id: "note.add", reason: "Synthetic" } });
  assert.equal((handoff as { mode?: string }).mode, "shadow");
  // A handoff chose the mode; the run's unshadowed action stays live.
  const live = await s.propose(handoff, "fact.explain", { object: null, explanation: "Synthetic explanation." });
  assert.notEqual(live.body.decision, "shadowed");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_run_steps WHERE action_id = 'fact.explain'").n, 1);
  // A watch is shadow only when every action it proposes is shadowed.
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody({ action_id: "visit.hold_slot" }), "owner", "shadow-hold-slot")).status, 200);
  assert.equal(((await s.run("lead_concierge", { kind: "watch", watch_id: "visit_request" })) as { mode?: string }).mode, "live");
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody({ action_id: "visit.confirm" }), "owner", "shadow-confirm")).status, 200);
  assert.equal(((await s.run("lead_concierge", { kind: "watch", watch_id: "visit_request" })) as { mode?: string }).mode, "shadow");
});

test("shadow steps count toward the run's step ceiling, and the step past it is a receipt, not a shadow row", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-ceiling")).status, 200);
  const run = await s.run();
  for (let index = 0; index < 12; index += 1) assert.equal((await s.propose(run, "note.add", { ...note, text: `Synthetic ${index}` })).body.decision, "shadowed");
  const over = await s.propose(run, "note.add", { ...note, text: "Synthetic thirteenth" });
  assert.deepEqual([over.body.outcome, over.body.reason_codes], ["abstained", ["ceiling_reached"]]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_shadow_steps").n, 12);
});

test("a catastrophe on a take-over blocks candidacy, unscored rows never count as compared, and the bar is 95 %", async () => {
  const s = setup(true);
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { action_id: string }) => row.action_id);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "c".repeat(64) }, "owner", "qualify-bar");
  assert.equal(qualified.status, 200);
  const seed = (count: number, verdict: string, catastrophes = "[]", action = "note.add") =>
    seedCompared(s, qualified.body.qualification_id, count, verdict, { catastrophes, action });
  await seed(60, "unscored");
  assert.deepEqual(await candidates(), [], "unscored rows are not comparisons");
  await seed(47, "match");
  await seed(3, "diverge");
  assert.deepEqual(await candidates(), [], "94 % is below the bar");
  await seed(50, "match");
  assert.deepEqual(await candidates(), ["note.add"]);
  await seed(1, "unscored", '["fabricates_fact"]');
  assert.deepEqual(await candidates(), [], "a flagged take-over blocks it");
  // Never-delegable and protective actions never become candidates, however good their record.
  await seed(60, "match", "[]", "exception.escalate");
  await seed(60, "match", "[]", "inquiry.classify");
  assert.deepEqual(await candidates(), []);
});

test("an unfinished catastrophe follow-through is completed by the sweep, and the system writer needs a within-limits row", async () => {
  const s = setup(true);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting())).status, 200);
  const run = await s.run();
  s.db.raw.prepare(`INSERT INTO agent_shadow_steps (shadow_step_id,tenant_id,run_id,specialist_id,action_id,step_key,args_json,args_sha256,sources_json,policy_json,subject_aggregate,subject_id,proposed_at) VALUES ('sstep_cat', ?, ?, 'lead_concierge', 'note.add', 'sstep_cat', '{}', ?, '[]', '{}', NULL, NULL, ?)`).run(TENANT, run.run_id, "0".repeat(64), s.now());
  s.db.raw.prepare(`INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at) VALUES ('agr_cat', ?, 'shadow', 'lead_concierge', 'note.add', 'sstep_cat', NULL, 'diverge', '["discloses_private_data"]', 'synthetic@1', NULL, ?)`).run(TENANT, s.now());
  const notices: string[] = [];
  await sweepShadow(s.db, TENANT, s.now(), async (subject) => void notices.push(subject));
  assert.equal((await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.setting, "asks_first");
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_exceptions WHERE dedupe_key = 'catastrophe:agr_cat'").n, 1);
  await sweepShadow(s.db, TENANT, s.now(), null);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_exceptions WHERE dedupe_key = 'catastrophe:agr_cat'").n, 1);
  // With no prior setting row, the system writer is refused outright.
  assert.throws(
    () =>
      s.db.raw
        .prepare(`INSERT INTO agent_delegation_settings (setting_id,tenant_id,specialist_id,action_id,revision,control_revision,catalog_version,policy_version,setting,ceiling_json,reason,set_by_user_id,set_at,idempotency_key) VALUES ('dlg_sys', ?, 'lead_concierge', 'visit.confirm', 1, 0, 'v', 'p', 'asks_first', NULL, 'Synthetic', 'system:auto_demotion', ?, 'sys-no-prior')`)
        .run(TENANT, s.now()),
    /agent_control_authority/,
  );
});

test("an audit closes completed only from a known family different from the reviewed run's", async () => {
  const s = setup();
  const reviewed = await s.run();
  const output = { decision: "propose", escalate_to: null, reason_code: null, reason: "Synthetic.", receipts: [], drafts: [], final_text: "Done." };
  const close = (model: Record<string, unknown> | null) => ({
    status: "ok", reason: null, detail: null, output, model,
    hashes: { system: "a".repeat(64), prompt: "b".repeat(64), schema: "c".repeat(64) },
    usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }, cost_usd: 0.01, attempts: 1, duration_ms: 10, tool_calls: [],
  });
  const model = (provider: string) => ({ provider, model: "synthetic-model", models_used: [], auth_mode: "oauth", tier: "audit" });
  assert.equal((await s.close(reviewed.run_id, close(model("codex")))).status, 200);
  for (const audited of [null, model("Codex"), model("gemini")]) {
    const audit = await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewed.run_id } });
    assert.equal((await s.close(audit.run_id, close(audited))).body.terminal, "abstained", JSON.stringify(audited));
  }
});

test("candidates need the full window and a delegable action; stats count only compared rows", async () => {
  const s = setup(true);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "d".repeat(64) }, "owner", "qualify-win");
  assert.equal(qualified.status, 200);
  const seed = (count: number, verdict: string, action = "note.add") => seedCompared(s, qualified.body.qualification_id, count, verdict, { action });
  await seed(49, "match");
  await seed(5, "unscored");
  await seed(60, "match", "consent.record");
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { action_id: string }) => row.action_id);
  assert.deepEqual(await candidates(), [], "49 compared is one short of the window; consent.record is never delegable");
  const note = (await s.app("/shadow?action=note.add")).body.agreement[0];
  assert.deepEqual([note.compared, note.counts.unscored, note.match_rate], [49, 5, 1]);
  await seed(1, "match");
  assert.deepEqual(await candidates(), ["note.add"]);
});

test("a watch id shared by specialists takes the run owner's list, and an unknown host mode abstains as a missing policy", async () => {
  const s = setup();
  for (const action_id of ["storm_watch.open", "market_alert.raise", "storm_mode.propose"])
    assert.equal((await s.app("/specialists/market_analyst/shadow", shadowBody({ action_id }), "owner", `shadow-ma-${action_id}`)).status, 200, action_id);
  assert.equal(((await s.run("market_analyst", { kind: "watch", watch_id: "storm_events" })) as { mode?: string }).mode, "shadow");
  assert.equal(((await s.run("orchestrator", { kind: "watch", watch_id: "storm_events" })) as { mode?: string }).mode, "live");
  const run = await s.run();
  const closed = await s.close(run.run_id, {
    status: "abstained", reason: "unknown_run_mode", detail: "Synthetic.", output: null, model: null, hashes: null,
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }, cost_usd: 0, attempts: 0, duration_ms: 0, tool_calls: [],
  });
  assert.equal(closed.body.terminal, "abstained");
  assert.equal(s.scalar("SELECT reason_code r FROM agent_run_steps WHERE run_id = ? AND action_id = 'exception.escalate'", run.run_id).r, "policy_missing");
});

test("a catastrophe follow-through that keeps failing never blocks the rest of the sweep", async () => {
  const s = setup();
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "shadow-sweep-iso")).status, 200);
  const run = await s.run();
  await s.propose(run, "note.add", note);
  s.db.raw.prepare(`INSERT INTO agent_shadow_steps (shadow_step_id,tenant_id,run_id,specialist_id,action_id,step_key,args_json,args_sha256,sources_json,policy_json,subject_aggregate,subject_id,proposed_at) VALUES ('sstep_bad', ?, ?, 'lead_concierge', 'note.add', 'sstep_bad', '{}', ?, '[]', '{}', NULL, NULL, ?)`).run(TENANT, run.run_id, "0".repeat(64), s.now());
  s.db.raw.prepare(`INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at) VALUES ('agr_bad', ?, 'shadow', 'lead_concierge', 'note.add', 'sstep_bad', NULL, 'diverge', '["fabricates_fact"]', 'synthetic@1', NULL, ?)`).run(TENANT, s.now());
  s.db.raw.exec("CREATE TRIGGER synthetic_exception_outage BEFORE INSERT ON agent_exceptions BEGIN SELECT RAISE(ABORT, 'synthetic outage'); END;");
  const later = new Date(Date.parse(s.now()) + SHADOW_COMPARE_WINDOW_MS).toISOString();
  assert.deepEqual(await sweepShadow(s.db, TENANT, later, null), { compared: 0, unscored: 1 });
});

test("the candidate bar uses the qualification for the model the specialist actually runs on", async () => {
  const s = setup(true);
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { model: string }) => row.model);
  const sol = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "b".repeat(64) }, "owner", "qualify-sol");
  await seedCompared(s, sol.body.qualification_id, 50, "match");
  assert.deepEqual(await candidates(), ["gpt-6.1-sol"]);
  // The specialist moves to another model on the same release: the bar follows it, and a passed
  // qualification on the model it left does not count.
  const runsOn = async (model: Record<string, unknown>) => {
    s.tick(60_000);
    assert.equal((await s.close((await s.run()).run_id, closeV3(model))).status, 200);
  };
  const astra = { model: "gpt-6-astra", models_used: ["gpt-6-astra"], effort: "high" };
  await runsOn({ ...astra, qualification_ref: null });
  assert.deepEqual(await candidates(), [], "no qualification on the model it moved to");
  const astraPassed = await s.app("/qualifications", { ...QUALIFIED, model: "gpt-6-astra", effort: "high", passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-astra");
  await runsOn({ ...astra, qualification_ref: astraPassed.body.qualification_id });
  assert.deepEqual(await candidates(), ["gpt-6-astra"], "the bar follows the model the specialist moved to");
  await runsOn({ ...astra, provider: "openai", adapter: "openai_compatible", qualification_ref: null });
  assert.deepEqual(await candidates(), [], "the same model through another provider needs its own qualification");
  // Every key is required, and an invalid one is refused.
  for (const [field, value, code] of [["provider", "Codex", "invalid_provider"], ["effort", "", "invalid_effort"], ["release_sha256", "x", "invalid_release_hash"]] as const)
    assert.equal((await s.app("/qualifications", { ...QUALIFIED, [field]: value, passed: true, report_sha256: "c".repeat(64) }, "owner", `qualify-bad-${field}`)).body.error, code);
  const { release_sha256: _omitted, ...missing } = QUALIFIED;
  assert.equal((await s.app("/qualifications", { ...missing, passed: true, report_sha256: "d".repeat(64) }, "owner", "qualify-missing")).body.error, "invalid_body");
  // A close without a model never hides the model the specialist runs on.
  s.tick(60_000);
  const bare = await s.run();
  const body = closeBody({ ...DRAFT_OUTPUT, drafts: [] });
  assert.equal((await s.close(bare.run_id, { ...body, status: "abstained", reason: "kill_switch", output: null, model: null, hashes: null })).status, 200);
  assert.deepEqual(await candidates(), [], "still openai gpt-6-astra, which has no qualification");
});

test("a qualification replays on its key and conflicts on any changed field; the schema refuses what the API would", async () => {
  const s = setup();
  const body = { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) };
  const first = await s.app("/qualifications", body, "owner", "qualify-replay");
  assert.equal(first.status, 200);
  assert.equal((await s.app("/qualifications", body, "owner", "qualify-replay")).body.qualification_id, first.body.qualification_id);
  for (const [field, value] of [["specialist_id", "estimator"], ["provider", "openai"], ["model", "gpt-6-astra"], ["effort", "high"], ["release_sha256", "f".repeat(64)], ["passed", false], ["report_sha256", "b".repeat(64)]] as const)
    assert.equal((await s.app("/qualifications", { ...body, [field]: value }, "owner", "qualify-replay")).body.error, "idempotency_conflict", field);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_qualifications").n, 1);
  const owner = s.scalar("SELECT recorded_by_user_id u FROM agent_qualifications").u;
  for (const [provider, effort, release] of [["Codex", "medium", "e".repeat(64)], ["codex", "", "e".repeat(64)], ["codex", "medium", "E".repeat(64)]])
    assert.throws(
      () =>
        s.db.raw
          .prepare(`INSERT INTO agent_qualifications (qualification_id,tenant_id,specialist_id,provider,model,effort,release_sha256,passed,report_sha256,recorded_by_user_id,recorded_at,idempotency_key) VALUES (?, ?, 'lead_concierge', ?, 'gpt-6.1-sol', ?, ?, 1, ?, ?, ?, ?)`)
          .run(`qal_raw_${provider}${effort}`, TENANT, provider, effort, release, "a".repeat(64), owner, s.now(), `raw-${provider}-${effort}-${release[0]}`),
      /CHECK constraint failed/,
    );
});

// --- R3 gateway v3: run-open qualifications, the v3 close, independence and qualification at close ---

/** The v3 close of agent-host/src/host/runner.ts `closeBodyV3`, for one synthetic routine run. */
const CLOSE_V3 = JSON.parse(readFileSync(new URL("./fixtures/agent-close-v3.json", import.meta.url), "utf8"));
const closeV3 = (model: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({ ...CLOSE_V3, ...body, model: { ...CLOSE_V3.model, ...model } });
/** The owner records one qualification (passed unless it says otherwise) and gets its id back. */
async function qualify(s: ReturnType<typeof setup>, row: Record<string, unknown>, key: string): Promise<string> {
  const recorded = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64), ...row }, "owner", key);
  assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
  return recorded.body.qualification_id;
}
/** A passed row of another tenant for lead_concierge on the QUALIFIED route, written straight to D1. */
function otherTenantQualification(s: ReturnType<typeof setup>): string {
  s.db.raw
    .prepare(
      `INSERT OR IGNORE INTO app_users (user_id,tenant_id,email_normalized,display_name,role,access_role,frappe_user_id,active,created_by,created_at,updated_at)
      VALUES ('appu_other_owner', 'othertenant', 'other-owner@example.invalid', 'other', 'owner', 'owner', 'other-owner@example.invalid', 1, 'seed', ?, ?)`,
    )
    .run(s.now(), s.now());
  s.db.raw
    .prepare(
      `INSERT INTO agent_qualifications (qualification_id,tenant_id,specialist_id,provider,model,effort,release_sha256,passed,report_sha256,recorded_by_user_id,recorded_at,idempotency_key)
      VALUES ('qal_other_tenant', 'othertenant', 'lead_concierge', 'codex', 'gpt-6.1-sol', 'medium', ?, 1, ?, 'appu_other_owner', ?, 'other-tenant-row')`,
    )
    .run(QUALIFIED.release_sha256, "a".repeat(64), s.now());
  return "qal_other_tenant";
}
/** The reason code of the receipt a run's close left, or null when it left none. */
const closeReason = (s: ReturnType<typeof setup>, runId: string): string | null =>
  s.scalar("SELECT reason_code r FROM agent_run_steps WHERE run_id = ? AND action_id = 'exception.escalate'", runId)?.r ?? null;
/** The v3 model block of an audit on the shipped Claude route. */
const OPUS_AUDIT = { provider: "claude", adapter: "claude_agent_sdk", family: "anthropic", model: "claude-opus-5-5", effort: "high", models_used: ["claude-opus-5-5"], tier: "audit", route_id: "claude_opus", compliance_ref: "ai.anthropic.claude-commercial" };

test("a run's open sends the specialist's current qualifications, the latest row per key and only while it passed", async () => {
  const s = setup();
  const sol = await qualify(s, {}, "hint-sol");
  await qualify(s, { effort: "high" }, "hint-high-pass");
  await qualify(s, { effort: "high", passed: false, report_sha256: "b".repeat(64) }, "hint-high-fail");
  await qualify(s, { release_sha256: "f".repeat(64), passed: false }, "hint-release-fail");
  const release = await qualify(s, { release_sha256: "f".repeat(64), report_sha256: "c".repeat(64) }, "hint-release-pass");
  await qualify(s, { provider: "claude", model: "claude-opus-5-5", effort: "high" }, "hint-opus-1");
  const opus = await qualify(s, { provider: "claude", model: "claude-opus-5-5", effort: "high", report_sha256: "d".repeat(64) }, "hint-opus-2");
  await qualify(s, { specialist_id: "estimator" }, "hint-other-specialist");
  otherTenantQualification(s);
  const run = (await s.run()) as Record<string, any>;
  assert.equal(run.close_model, 3);
  // Newest first: a key failed last is left out, a key passed after a failure is in, a key passed
  // twice sends its newest row, and another specialist's or tenant's rows are not this run's.
  assert.deepEqual(run.qualifications, [
    { qualification_id: opus, provider: "claude", model: "claude-opus-5-5", effort: "high", release_sha256: "e".repeat(64) },
    { qualification_id: release, provider: "codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: "f".repeat(64) },
    { qualification_id: sol, provider: "codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: "e".repeat(64) },
  ]);
  assert.deepEqual(((await s.run("estimator")) as Record<string, any>).qualifications.map((row: { effort: string }) => row.effort), ["medium"]);
  assert.deepEqual(((await s.run("market_analyst")) as Record<string, any>).qualifications, []);
});

test("an audit's open names the reviewed run's family: a v3 close's own, a legacy provider's, or none it cannot name", async () => {
  const s = setup();
  const reviewOf = async (model: Record<string, unknown>, legacy = false) => {
    const reviewed = await s.run();
    const body = legacy ? { ...CLOSE_V3, model } : closeV3(model);
    assert.equal((await s.close(reviewed.run_id, body)).status, 200);
    const audit = (await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewed.run_id } })) as Record<string, any>;
    return { ...audit.review_of, run_id: audit.review_of.run_id === reviewed.run_id };
  };
  assert.deepEqual(await reviewOf({ provider: "vertex", adapter: "vertex", family: "google", model: "gemini-3.8-flash", models_used: [] }), { run_id: true, provider: "vertex", family: "google" });
  const legacy = (provider: string) => ({ provider, model: "synthetic-model", models_used: [], auth_mode: "oauth", tier: "routine" });
  assert.deepEqual(await reviewOf(legacy("claude"), true), { run_id: true, provider: "claude", family: "anthropic" });
  assert.deepEqual(await reviewOf(legacy("gemini"), true), { run_id: true, provider: "gemini" });
});

test("a v3 close is held to its strict block, and legacy and routed blocks still close", async () => {
  const s = setup();
  const ref = await qualify(s, {}, "shape-sol");
  const closed = await s.close((await s.run()).run_id, closeV3({ qualification_ref: ref }));
  assert.deepEqual([closed.status, closed.body.terminal], [200, "completed"]);
  const hop = { route_id: "codex_sol_low", provider: "codex", model: "gpt-6.1-sol", family: "openai", reason: "rate_limited", retry_at: 1_000_500.5 };
  // A hop whose route lost its registry entry names no family; outside an audit that changes nothing.
  const threeHops = await s.close((await s.run()).run_id, closeV3({ qualification_ref: ref, route: "declared_fallback", failover: [hop, { ...hop, family: null, retry_at: null }, hop] }));
  assert.deepEqual([threeHops.status, threeHops.body.terminal], [200, "completed"]);
  const { run_class: _runClass, ...missing } = CLOSE_V3.model;
  const { effort: _effort, ...effortless } = CLOSE_V3.model;
  const { family: _family, ...hopWithoutFamily } = hop;
  for (const [label, model] of [
    ["four failover hops", { failover: [hop, hop, hop, hop] }],
    ["a hop with a field of its own", { failover: [{ ...hop, effort: "medium" }] }],
    ["a hop without its family", { failover: [hopWithoutFamily] }],
    ["a hop family with capitals", { failover: [{ ...hop, family: "OpenAI" }] }],
    ["a hop on a provider id with capitals", { failover: [{ ...hop, provider: "Codex" }] }],
    ["an effort outside the qualification format", { effort: "High" }],
    ["a release hash one short", { release_sha256: "e".repeat(63) }],
    ["an upper-case configuration hash", { gateway_config_sha256: "E".repeat(64) }],
    ["a provider id with capitals", { provider: "Codex" }],
    ["a provider id too long", { provider: `p${"a".repeat(31)}` }],
    ["a family too long", { family: `f${"a".repeat(32)}` }],
    ["an adapter outside the contract", { adapter: "omniroute" }],
    ["a run class outside the register", { run_class: "practice" }],
    ["a review naming no family", { review_of: { run_id: "run_x", provider: "codex" } }],
    ["nine models used", { models_used: Array.from({ length: 9 }, (_, n) => `gpt-6.${n}`) }],
    ["a hop retrying before the epoch", { failover: [{ ...hop, retry_at: -1 }] }],
    ["an auth mode outside the registry", { auth_mode: "password" }],
    ["a billing outside the registry", { billing: "invoice" }],
    ["a qualification ref too long", { qualification_ref: `q${"a".repeat(80)}` }],
    ["a field of its own", { extra: true }],
  ] as const)
    assert.equal((await s.close((await s.run()).run_id, closeV3(model)).then((r) => r.status)), 422, label);
  assert.equal((await s.close((await s.run()).run_id, { ...CLOSE_V3, model: missing })).status, 422, "a block without its run class");
  assert.equal((await s.close((await s.run()).run_id, { ...CLOSE_V3, model: effortless })).status, 422, "a block without its effort");
  // A routed block that names a family is held to the v3 block, which it does not meet.
  const routed = { provider: "codex", model: "gpt-6.1-sol", models_used: ["gpt-6.1-sol"], auth_mode: "chatgpt", tier: "routine", route_id: "codex_sol", review_of: null, mode: "live" };
  assert.equal((await s.close((await s.run()).run_id, { ...CLOSE_V3, model: { ...routed, family: "openai" } })).status, 422);
  // An older host's blocks carry no run class and no qualification, and close as before.
  const { route_id: _route, review_of: _review, mode: _mode, ...legacy } = routed;
  for (const model of [routed, legacy]) assert.equal((await s.close((await s.run()).run_id, { ...CLOSE_V3, model })).body.terminal, "completed");
  // Only a v3 close records the Worker's data class next to its run class.
  const stored = s.db.raw.prepare("SELECT close_json FROM agent_runs WHERE state = 'closed' ORDER BY rowid").all() as Array<{ close_json: string }>;
  assert.deepEqual(stored.map((row) => JSON.parse(row.close_json).data_class ?? null), ["business", "business", null, null]);
});

test("a synthetic run closes only on a Worker that holds synthetic data, and an eval run on none", async () => {
  const business = setup();
  const run = await business.run();
  const consumer = { qualification_ref: null, compliance_ref: "ai.openai.chatgpt-consumer" };
  const refused = await business.close(run.run_id, closeV3({ ...consumer, run_class: "synthetic" }));
  assert.deepEqual([refused.status, refused.body.error], [422, "run_class_refused"]);
  const abstained = { status: "abstained", reason: "rate_limited", detail: "Synthetic.", output: null };
  assert.equal((await business.close(run.run_id, closeV3({ ...consumer, run_class: "synthetic" }, abstained))).body.error, "run_class_refused");
  assert.equal((await business.close(run.run_id, closeV3({ ...consumer, run_class: "eval_history" }))).body.error, "run_class_refused");
  assert.equal(business.scalar("SELECT state FROM agent_runs WHERE run_id = ?", run.run_id).state, "open", "a refused close records nothing");
  assert.equal((await setup(false, { AGENT_DATA_CLASS: "business" }).close(run.run_id, {})).status, 404, "an explicit business class serves as the default does");

  const synthetic = setup(false, { AGENT_DATA_CLASS: " synthetic " });
  const qa = await synthetic.run();
  const body = closeV3({ ...consumer, run_class: "synthetic" });
  const closed = await synthetic.close(qa.run_id, body);
  assert.deepEqual([closed.status, closed.body.terminal], [200, "completed"], "a synthetic run relies on no qualification");
  const stored = JSON.parse(synthetic.scalar("SELECT close_json c FROM agent_runs WHERE run_id = ?", qa.run_id).c);
  assert.deepEqual([stored.data_class, stored.model.run_class, stored.model.compliance_ref], ["synthetic", "synthetic", "ai.openai.chatgpt-consumer"]);
  assert.equal((await synthetic.close(qa.run_id, body)).status, 200, "the exact retry replays");
  assert.equal((await synthetic.close((await synthetic.run()).run_id, closeV3({ ...consumer, run_class: "eval_history" }))).body.error, "run_class_refused");
  // A live run on a synthetic Worker still needs a qualification the Worker holds.
  const live = await synthetic.run();
  assert.equal((await synthetic.close(live.run_id, closeV3({ qualification_ref: null }))).body.terminal, "abstained");
  assert.equal(closeReason(synthetic, live.run_id), "no_qualified_route");
  // A data class that is neither stops the host API instead of reading as either.
  const misspelt = await setup(false, { AGENT_DATA_CLASS: "Synthetic" }).close("run_x", body);
  assert.deepEqual([misspelt.status, misspelt.body.error], [503, "data_class_not_configured"]);
});

test("a live or shadow close keeps its output only on a qualification the Worker holds for its route and release", async () => {
  const s = setup();
  const ref = await qualify(s, {}, "ref-sol-pass");
  const closeWith = async (model: Record<string, unknown>, body: Record<string, unknown> = {}) => {
    const run = await s.run();
    const closed = await s.close(run.run_id, closeV3(model, body));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    return [closed.body.terminal, closeReason(s, run.run_id)];
  };
  const kept = ["completed", null];
  const refused = ["abstained", "no_qualified_route"];
  assert.deepEqual(await closeWith({ qualification_ref: ref }), kept);
  assert.deepEqual(await closeWith({ qualification_ref: ref, mode: "shadow", run_class: "shadow" }), kept);
  for (const [label, model] of [
    ["another provider", { provider: "openai", adapter: "openai_compatible", auth_mode: "api_key", billing: "api" }],
    ["another model", { model: "gpt-6-astra", models_used: ["gpt-6-astra"] }],
    ["another effort", { effort: "high" }],
    ["another release", { release_sha256: "f".repeat(64) }],
    ["no release", { release_sha256: null }],
    ["no reference", { qualification_ref: null }],
    ["a reference the Worker never recorded", { qualification_ref: "qal_00000000-0000-4000-8000-000000000000" }],
    ["a shadow run with no reference", { qualification_ref: null, mode: "shadow", run_class: "shadow" }],
  ] as const)
    assert.deepEqual(await closeWith({ qualification_ref: ref, ...model }), refused, label);
  // Another specialist's row for the same route and release is not this specialist's, and another
  // tenant's row is not this tenant's.
  assert.deepEqual(await closeWith({ qualification_ref: await qualify(s, { specialist_id: "estimator" }, "ref-estimator") }), refused);
  assert.deepEqual(await closeWith({ qualification_ref: otherTenantQualification(s) }), refused);
  // A failure at another effort of the same route and release is another key, so the reference holds.
  await qualify(s, { effort: "high", passed: false, report_sha256: "b".repeat(64) }, "ref-high-fail");
  assert.deepEqual(await closeWith({ qualification_ref: ref }), kept);
  // A failure recorded later for its own key ends it, even though the row itself passed; the failed
  // row is no reference, and a new passed row is.
  const failed = await qualify(s, { passed: false, report_sha256: "c".repeat(64) }, "ref-sol-fail");
  assert.deepEqual(await closeWith({ qualification_ref: ref }), refused);
  assert.deepEqual(await closeWith({ qualification_ref: failed }), refused);
  const again = await qualify(s, { report_sha256: "d".repeat(64) }, "ref-sol-again");
  assert.deepEqual(await closeWith({ qualification_ref: again }), kept);
  assert.deepEqual(await closeWith({ qualification_ref: ref }), refused, "the failure still sits between the old row and now");
  // The check only ever stops output: an abstention keeps its own reason.
  assert.deepEqual(await closeWith({ qualification_ref: null }, { status: "abstained", reason: "rate_limited", detail: "Synthetic.", output: null }), ["abstained", "provider_unavailable"]);
  // An emergency the refused output raised stays its reason, so it reaches a person.
  assert.deepEqual(await closeWith({ qualification_ref: null }, { output: { ...CLOSE_V3.output, decision: "escalate", escalate_to: "owner", reason_code: "emergency" } }), ["abstained", "emergency"]);
  // Refused output is recorded without its work and with the reason; its exact retry replays.
  const unqualified = await s.run();
  const body = closeV3({ qualification_ref: null });
  assert.equal((await s.close(unqualified.run_id, body)).body.terminal, "abstained");
  const stored = JSON.parse(s.scalar("SELECT close_json c FROM agent_runs WHERE run_id = ?", unqualified.run_id).c);
  assert.deepEqual([stored.output, stored.refused, stored.model.qualification_ref, stored.data_class], [null, { reason: "no_qualified_route" }, null, "business"]);
  assert.equal((await s.close(unqualified.run_id, body)).status, 200, "the exact retry replays");
  assert.equal((await s.close(unqualified.run_id, closeV3({ qualification_ref: null }, { cost_usd: 0.02 }))).status, 409);
});

test("an audit closes completed only off the reviewed run's family, on the hop it ran and every hop it passed over", async () => {
  const s = setup();
  const reviewed = await s.run();
  assert.equal((await s.close(reviewed.run_id, closeV3({ qualification_ref: await qualify(s, {}, "audit-reviewed") }))).body.terminal, "completed");
  const opus = await qualify(s, { specialist_id: "independent_auditor", provider: "claude", model: "claude-opus-5-5", effort: "high" }, "audit-opus");
  const audit = async (model: Record<string, unknown>, reviewedRun = reviewed.run_id) => {
    const run = await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewedRun } });
    const closed = await s.close(run.run_id, closeV3({ ...OPUS_AUDIT, qualification_ref: opus, review_of: { run_id: reviewedRun, family: "openai" }, ...model }));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    return [closed.body.terminal, closeReason(s, run.run_id)];
  };
  const kept = ["completed", null];
  const notIndependent = ["abstained", "provider_unavailable"];
  assert.deepEqual(await audit({}), kept);
  // Every hop the audit passed over names its family. A hop off the reviewed run's family passes,
  // on another account too: the declared fallback from Anthropic's API to Vertex is one family.
  const opusHop = { route_id: "claude_opus", provider: "claude", model: "claude-opus-5-5", family: "anthropic", reason: "rate_limited", retry_at: null };
  const vertex = await qualify(s, { specialist_id: "independent_auditor", provider: "vertex", model: "claude-opus-5-5", effort: "high" }, "audit-vertex");
  assert.deepEqual(await audit({ provider: "vertex", adapter: "vertex", qualification_ref: vertex, route: "declared_fallback", route_id: "opus_vertex", failover: [opusHop] }), kept);
  assert.deepEqual(await audit({ route: "declared_fallback", failover: [{ ...opusHop, provider: "gemini", model: "gemini-3.8-flash", family: "google" }] }), kept);
  // A hop of the reviewed run's family ran the audit on the proposer's family; a hop that names no
  // family cannot be shown to be off it. Either way the audit is not accepted.
  const proposerHop = { route_id: "codex_astra", provider: "codex", model: "gpt-6-astra", family: "openai", reason: "provider_error", retry_at: null };
  assert.deepEqual(await audit({ route: "declared_fallback", failover: [opusHop, proposerHop] }), notIndependent);
  assert.deepEqual(await audit({ provider: "vertex", adapter: "vertex", qualification_ref: vertex, route: "declared_fallback", route_id: "opus_vertex", failover: [{ ...opusHop, family: null }] }), notIndependent);
  // The audit's own family the same as the reviewed run's.
  const astra = await qualify(s, { specialist_id: "independent_auditor", model: "gpt-6-astra", effort: "high" }, "audit-astra");
  assert.deepEqual(await audit({ provider: "codex", adapter: "codex", family: "openai", model: "gpt-6-astra", models_used: [], route_id: "codex_astra", qualification_ref: astra }), notIndependent);
  // A legacy reviewed run's provider maps to its family, and a legacy audit's too.
  const legacy = await s.run();
  const legacyModel = (provider: string) => ({ provider, model: "synthetic-model", models_used: [], auth_mode: "oauth", tier: "audit" });
  assert.equal((await s.close(legacy.run_id, { ...CLOSE_V3, model: legacyModel("codex") })).body.terminal, "completed");
  assert.deepEqual(await audit({}, legacy.run_id), kept);
  assert.deepEqual(await audit({ provider: "codex", adapter: "codex", family: "openai", model: "gpt-6-astra", models_used: [], route_id: "codex_astra", qualification_ref: astra }, legacy.run_id), notIndependent);
  const legacyAudit = async (provider: string, reviewedRun: string) => {
    const run = await s.run("independent_auditor", { subject: { aggregate: "coordination_run", id: reviewedRun } });
    return (await s.close(run.run_id, { ...CLOSE_V3, model: legacyModel(provider) })).body.terminal;
  };
  assert.deepEqual([await legacyAudit("claude", reviewed.run_id), await legacyAudit("codex", reviewed.run_id)], ["completed", "abstained"]);
  // A reviewed run whose family cannot be named cannot be audited independently.
  const unknown = await s.run();
  assert.equal((await s.close(unknown.run_id, { ...CLOSE_V3, model: legacyModel("gemini") })).body.terminal, "completed");
  assert.deepEqual(await audit({}, unknown.run_id), notIndependent);
  assert.equal(await legacyAudit("claude", unknown.run_id), "abstained");
  const refused = s.db.raw.prepare("SELECT close_json FROM agent_runs WHERE specialist_id = 'independent_auditor' AND result = 'abstained'").all() as Array<{ close_json: string }>;
  assert.ok(refused.length > 0);
  for (const row of refused) assert.deepEqual([JSON.parse(row.close_json).output, JSON.parse(row.close_json).refused], [null, { reason: "provider_unavailable" }]);
});

test("the candidate bar needs the qualification for the effort and release the specialist runs on", async () => {
  const s = setup(true);
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { qualification_id: string }) => row.qualification_id);
  const runsOnV3 = async (model: Record<string, unknown>) => {
    s.tick(1000);
    assert.equal((await s.close((await s.run()).run_id, closeV3(model))).status, 200);
  };
  const medium = await qualify(s, {}, "bar-medium");
  await qualify(s, { effort: "high" }, "bar-high");
  await seedCompared(s, medium, 50, "match");
  assert.deepEqual(await candidates(), [medium]);
  // The latest row for the model is a failure at another effort: the route the specialist runs on still holds.
  s.tick(1000);
  await qualify(s, { effort: "high", passed: false, report_sha256: "b".repeat(64) }, "bar-high-fail");
  assert.deepEqual(await candidates(), [medium]);
  s.tick(1000);
  await qualify(s, { passed: false, report_sha256: "c".repeat(64) }, "bar-medium-fail");
  assert.deepEqual(await candidates(), [], "its own effort failed");
  // A new release counts only its own decisions and needs its own qualification: neither the earlier
  // release's decisions nor its rows carry over.
  const newRelease = { release_sha256: "f".repeat(64) };
  const release = await qualify(s, { ...newRelease, report_sha256: "d".repeat(64) }, "bar-release");
  await runsOnV3({ qualification_ref: release, ...newRelease });
  assert.deepEqual(await candidates(), [], "the earlier release's decisions do not count");
  await seedCompared(s, release, 50, "match", { model: newRelease });
  assert.deepEqual(await candidates(), [release]);
  s.tick(1000);
  await qualify(s, { ...newRelease, passed: false, report_sha256: "e".repeat(64) }, "bar-release-fail");
  assert.deepEqual(await candidates(), []);
  // The specialist moves to the high effort at that release: the bar follows the effort its close names.
  const high = await qualify(s, { ...newRelease, effort: "high", report_sha256: "f".repeat(64) }, "bar-release-high");
  await runsOnV3({ qualification_ref: high, effort: "high", ...newRelease });
  assert.deepEqual(await candidates(), [high]);
  await runsOnV3({ qualification_ref: null, effort: "high", release_sha256: "1".repeat(64) });
  assert.deepEqual(await candidates(), [], "no row at that release");
});

// --- Delegation fallbacks on a release without a passed qualification (contract "Delegation" item 7) ---

/** A host's close of a live run that found no route a current passed qualification names. */
const unqualifiedClose = () => ({ ...CLOSE_V3, status: "abstained", reason: "no_qualified_route", detail: "Synthetic: no qualified route.", output: null, model: { ...CLOSE_V3.model, qualification_ref: null } });

test("a within-limits setting falls back once a run of the specialist ends without a qualified route, until the owner sets it again", async () => {
  const s = setup(true);
  const delegation = async () => {
    const current = await currentDelegation(s.db, TENANT, "lead_concierge", "note.add");
    return [current?.setting, current?.fallback];
  };
  // A run that ended without a qualified route before the owner set the action does not count.
  const before = await s.run();
  assert.equal((await s.close(before.run_id, closeV3({ qualification_ref: null }))).status, 200);
  s.tick(1_000);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting(), "owner", "deleg-release-1")).status, 200);
  assert.deepEqual(await delegation(), ["within_limits", false]);
  // A run of the same specialist that ran and closed fine changes nothing.
  s.tick(1_000);
  assert.equal((await s.close((await s.run()).run_id, closeV3({ qualification_ref: await qualify(s, {}, "release-pass") }))).status, 200);
  assert.deepEqual(await delegation(), ["within_limits", false]);
  // The host found no qualified route for the specialist's changed release: the setting asks first.
  s.tick(1_000);
  const abstained = await s.run();
  const closed = await s.close(abstained.run_id, unqualifiedClose());
  assert.deepEqual([closed.status, closed.body.terminal], [200, "abstained"]);
  assert.deepEqual(await delegation(), ["asks_first", true]);
  // It stays back after the release passes, until the owner confirms the setting again.
  s.tick(1_000);
  assert.equal((await s.close((await s.run()).run_id, closeV3({ qualification_ref: await qualify(s, {}, "release-pass-again") }))).status, 200);
  assert.deepEqual(await delegation(), ["asks_first", true]);
  s.tick(1_000);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting({ expected_revision: 1 }), "owner", "deleg-release-2")).status, 200);
  assert.deepEqual(await delegation(), ["within_limits", false]);
  // A close the Worker refuses for a route it holds no qualification for counts the same way.
  s.tick(1_000);
  const refused = await s.close((await s.run()).run_id, closeV3({ qualification_ref: null }));
  assert.deepEqual([refused.status, refused.body.terminal], [200, "abstained"]);
  assert.deepEqual(await delegation(), ["asks_first", true]);
  // The pair's record shows the fallback, the stored revision behind it and who set it.
  const { delegationRecord } = await import("../src/agents/shadow.ts");
  const fallen = (await delegationRecord(s.db, TENANT, "lead_concierge:note.add")) as any;
  assert.deepEqual(
    [fallen.setting.setting, fallen.setting.fallback, fallen.setting.ceiling, fallen.setting.revision, fallen.setting.set_by, fallen.failed_readback],
    ["asks_first", true, ceiling, 2, "person:appu_test_owner", 0],
  );
  assert.equal(fallen.setting.setting_id, (await currentDelegation(s.db, TENANT, "lead_concierge", "note.add"))?.delegation_id);
  // Another specialist's run without a qualified route never touches this one's setting.
  s.tick(1_000);
  assert.equal((await s.app("/specialists/lead_concierge/delegation", setting({ expected_revision: 2 }), "owner", "deleg-release-3")).status, 200);
  assert.equal((await s.app("/specialists/estimator/delegation", setting(), "owner", "deleg-release-estimator")).status, 200);
  s.tick(1_000);
  assert.equal((await s.close((await s.run("estimator")).run_id, unqualifiedClose())).status, 200);
  const estimator = await currentDelegation(s.db, TENANT, "estimator", "note.add");
  assert.deepEqual([estimator?.setting, estimator?.fallback], ["asks_first", true]);
  assert.deepEqual(await delegation(), ["within_limits", false], "lead_concierge's setting stands");
});

test("a practice-only action stops practising after a catastrophe or an unqualified release, and stays practice only until the owner sets it again", async () => {
  const s = setup(true);
  const overview = async () => (await s.app("/specialists/lead_concierge")).body.actions.find((action: { action_id: string }) => action.action_id === "note.add").shadow;
  const practise = async (text: string) => (await s.propose(await s.run(), "note.add", { ...note, text })).body;
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "practice-1")).status, 200);
  const first = await practise("Synthetic note one.");
  assert.equal(first.decision, "shadowed");
  // A run of the specialist ends without a qualified route: the action neither practises nor runs.
  s.tick(1_000);
  assert.equal((await s.close((await s.run()).run_id, unqualifiedClose())).status, 200);
  const stopped = await practise("Synthetic note two.");
  assert.deepEqual([stopped.decision, stopped.reason_codes], ["denied", ["policy_denied"]]);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_shadow_steps WHERE action_id = 'note.add'").n, 1);
  assert.equal(s.scalar("SELECT COUNT(*) n FROM agent_run_steps WHERE action_id = 'note.add' AND needs_reviewer_role IS NOT NULL").n, 0, "no person is handed it");
  // The run's mode is live: no action it can lead to is practising.
  const handoff = await s.run("lead_concierge", { kind: "handoff", content: { expected_action_id: "note.add", reason: "Synthetic" } });
  assert.equal((handoff as { mode?: string }).mode, "live");
  assert.deepEqual(await overview(), { shadow: true, revision: 1, stopped: true });
  // The owner confirms practice again: it practises.
  s.tick(1_000);
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody({ expected_revision: 1 }), "owner", "practice-2")).status, 200);
  assert.deepEqual(await overview(), { shadow: true, revision: 2, stopped: false });
  const resumed = await practise("Synthetic note three.");
  assert.equal(resumed.decision, "shadowed");
  // A practice step recorded as a catastrophe stops it again.
  s.tick(1_000);
  s.db.raw
    .prepare(
      `INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at)
      VALUES ('agr_synthetic_catastrophe', ?, 'shadow', 'lead_concierge', 'note.add', ?, NULL, 'diverge', '["fabricates_fact"]', 'synthetic', NULL, ?)`,
    )
    .run(TENANT, resumed.step_id, s.now());
  assert.deepEqual((await practise("Synthetic note four.")).reason_codes, ["policy_denied"]);
  assert.equal((await overview()).stopped, true);
});

test("only decisions under the current step policy and release count toward the bar, and a refused close's never do", async () => {
  const s = setup(true);
  const candidates = async () => (await s.app("/shadow/candidates")).body.candidates.map((row: { action_id: string }) => row.action_id);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-policy");
  await seedCompared(s, qualified.body.qualification_id, 49, "match");
  // A run the Worker refused for a route without its qualification keeps its model block, not its work.
  await seedCompared(s, null, 1, "match");
  assert.deepEqual(await candidates(), [], "the refused run's decision does not count");
  // A run opened under an earlier step policy: its decisions do not count either.
  s.tick(1_000);
  const current = await s.run();
  s.db.raw.exec("CREATE TEMP TABLE old_run AS SELECT * FROM agent_runs WHERE 0");
  s.db.raw.prepare("INSERT INTO old_run SELECT * FROM agent_runs WHERE run_id = ?").run(current.run_id);
  s.db.raw.exec(`UPDATE old_run SET run_id = 'run_old_policy', host_run_key = 'host-old-policy', policy_version = 'ironwrap.step-policy@3'`);
  s.db.raw.exec("INSERT INTO agent_runs SELECT * FROM old_run");
  s.db.raw
    .prepare(
      `INSERT INTO agent_shadow_steps (shadow_step_id,tenant_id,run_id,specialist_id,action_id,step_key,args_json,args_sha256,sources_json,policy_json,subject_aggregate,subject_id,proposed_at)
      VALUES ('sstep_old_policy', ?, 'run_old_policy', 'lead_concierge', 'note.add', 'old', '{}', ?, '[]', '{}', NULL, NULL, ?)`,
    )
    .run(TENANT, "0".repeat(64), s.now());
  s.db.raw
    .prepare(
      `INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at)
      VALUES ('agr_old_policy', ?, 'shadow', 'lead_concierge', 'note.add', 'sstep_old_policy', NULL, 'match', '[]', 'synthetic@1', NULL, ?)`,
    )
    .run(TENANT, s.now());
  const kept = s.scalar("SELECT close_json c FROM agent_runs WHERE state = 'closed' AND json_extract(close_json, '$.refused') IS NULL ORDER BY rowid DESC LIMIT 1").c;
  s.db.raw.prepare("UPDATE agent_runs SET state = 'closed', result = 'completed', close_json = ?, ended_at = ?, version = version + 1 WHERE run_id = 'run_old_policy'").run(kept, s.now());
  assert.deepEqual(await candidates(), [], "the earlier policy's decision does not count");
  // One more decision under the current policy and release fills the window.
  await seedCompared(s, qualified.body.qualification_id, 1, "match");
  assert.deepEqual(await candidates(), ["note.add"]);
});

// --- Earned autonomy: the face's proposal, the owner's preview and the weekly review (contract "Delegation" items 4 and 13) ---

/** A delegation change the face proposes for lead_concierge's note.add. */
const proposal = (overrides: Record<string, unknown> = {}) => ({
  specialist_id: "lead_concierge",
  action_id: "note.add",
  proposed: "within_limits",
  ceiling,
  reason: "Synthetic: fifty compared notes, all matched.",
  ...overrides,
});

test("the face proposes acting within limits only where the earned-autonomy bar is met, and the owner decides it in their own screen", async () => {
  const s = setup(true);
  const face = async () => await s.run("orchestrator", { kind: "watch", watch_id: "delegation_review" });
  const earned = (body: { receipt: { policy: { checks: Array<{ check: string; passed: boolean }> } } }) =>
    body.receipt.policy.checks.find((check) => check.check === "earned_autonomy");
  // Below the bar the proposal is refused, and nobody is handed it.
  const below = (await s.propose(await face(), "delegation.propose_change", proposal())).body;
  assert.deepEqual([below.decision, below.reason_codes, earned(below)], ["denied", ["policy_denied"], { check: "earned_autonomy", passed: false }]);
  assert.equal(below.receipt.needs_from_you, null);
  // Practice only and asks first need no bar.
  assert.equal((await s.propose(await face(), "delegation.propose_change", proposal({ proposed: "shadow", ceiling: null }))).body.decision, "drafted");
  // Once the action meets the bar, the proposal is a draft that waits in the owner's Needs you.
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-propose");
  await seedCompared(s, qualified.body.qualification_id, 50, "match");
  const met = (await s.propose(await face(), "delegation.propose_change", proposal({ reason: "Synthetic: the bar is met." }))).body;
  assert.deepEqual([met.decision, met.receipt.outcome, earned(met)], ["drafted", "succeeded", { check: "earned_autonomy", passed: true }]);
  assert.deepEqual([met.receipt.needs_from_you.reviewer_role, met.receipt.needs_from_you.ask], ["owner", "Check this and apply it yourself in your own screen; the AI team only prepared it."]);
  assert.ok((await s.app("/receipts?view=needs_you")).body.receipts.some((entry: { step_id: string }) => entry.step_id === met.step_id));
  // An action whose autonomy cannot be earned, or a ceiling that does not match the setting, is never proposed.
  for (const [label, args] of [
    ["a people-only action", proposal({ action_id: "delegation.set", specialist_id: "orchestrator" })],
    ["a never-delegable action", proposal({ action_id: "consent.record" })],
    ["a specialist that does not own the action", proposal({ specialist_id: "synthetic_nobody" })],
    ["within limits without a ceiling", proposal({ ceiling: null })],
    ["practice only with a ceiling", proposal({ proposed: "shadow" })],
  ] as const) {
    const refused = (await s.propose(await face(), "delegation.propose_change", args)).body;
    assert.deepEqual([refused.decision, refused.reason_codes], ["abstained", ["action_unregistered"]], label);
  }
});

test("the owner's preview shows the counted decisions, the bar, the history and what the ceiling would have let run", async () => {
  const s = setup(true);
  const preview = async (query: string) => await s.app(`/specialists/lead_concierge/preview?${query}`);
  const empty = (await preview("action=note.add")).body;
  assert.deepEqual([empty.release_sha256, empty.window.compared, empty.bar.meets, empty.would_have_run], [null, 0, false, null]);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-preview");
  await seedCompared(s, qualified.body.qualification_id, 48, "match");
  await seedCompared(s, qualified.body.qualification_id, 2, "diverge");
  // The ceiling lets two run in any hour; the seeded proposals were all made within the same hour.
  const shown = (await preview(`action=note.add&ceiling=${encodeURIComponent(JSON.stringify(ceiling))}`)).body;
  assert.deepEqual(shown.window, { compared: 50, match: 48, partial: 0, diverge: 2, match_rate: 0.96, catastrophe: false });
  assert.deepEqual([shown.release_sha256, shown.bar], ["e".repeat(64), { compared: 50, match_rate: 0.95, meets: true }]);
  assert.deepEqual(shown.practice, { proposed: 50, compared: 50 });
  assert.deepEqual(shown.would_have_run, { ran: 2, ran_not_matching: 0, of: 50 });
  // A wider ceiling lets every one run, the two a person would not have matched among them.
  const wide = { ...ceiling, count: { max: 100, per: "hour" } };
  assert.deepEqual((await preview(`action=note.add&ceiling=${encodeURIComponent(JSON.stringify(wide))}`)).body.would_have_run, { ran: 50, ran_not_matching: 2, of: 50 });
  // Only an action whose autonomy can be earned has a preview, and the query is checked.
  assert.equal((await preview("action=consent.record")).status, 422);
  assert.equal((await preview("action=note.add&ceiling=%7Bbad")).status, 400);
  assert.equal((await preview(`action=note.add&ceiling=${encodeURIComponent(JSON.stringify({ count: { max: 0, per: "hour" }, amount: null, recipients: null }))}`)).status, 400);
  assert.equal((await s.app("/specialists/lead_concierge/preview?action=note.add", undefined, "sales")).status, 403);
});

test("a specialist's declined proposal still counts against it, and a refused close can count against it but never for it", async () => {
  const s = setup(true);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-declined");
  await seedCompared(s, qualified.body.qualification_id, 49, "match");
  // A real proposal on a kept run that the owner declines: a compared decision that did not match.
  const run = await s.run();
  const step = (await s.propose(run, "note.add", { ...note, text: "Synthetic note the owner declines." })).body;
  const row = s.scalar("SELECT version, args_sha256 FROM agent_run_steps WHERE step_id = ?", step.step_id);
  assert.equal((await s.app(`/steps/${step.step_id}/decision`, { decision: "decline", expected_version: row.version, expected_args_sha256: row.args_sha256 }, "owner", "decline-counted")).status, 200);
  s.tick(1_000);
  assert.equal((await s.close(run.run_id, closeV3({ qualification_ref: qualified.body.qualification_id }))).body.terminal, "completed");
  const window = async () => (await s.app("/specialists/lead_concierge/preview?action=note.add")).body.window;
  assert.deepEqual([(await window()).compared, (await window()).diverge], [50, 1], "the declined proposal counts");
  // A refused close cannot earn autonomy: its matches are left out, while what did not match on it
  // still counts against the specialist.
  await seedCompared(s, null, 5, "match");
  assert.deepEqual([(await window()).compared, (await window()).diverge, (await window()).match], [50, 1, 49], "the refused run's matches do not count");
  await seedCompared(s, null, 2, "diverge");
  assert.deepEqual([(await window()).compared, (await window()).diverge], [50, 3], "the refused run's divergences do");
});

test("the weekly delegation review holds when an action meets the bar or has enough counted decisions for a preview", async () => {
  const s = setup(true);
  const review = async () => await WATCH_CONDITIONS.delegation_review.evaluate(s.db, TENANT, null, s.now());
  assert.equal((await review()).holds, false);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-review");
  await seedCompared(s, qualified.body.qualification_id, 45, "match");
  await seedCompared(s, qualified.body.qualification_id, 5, "diverge");
  const previewOnly = await review();
  assert.equal(previewOnly.holds, true);
  assert.deepEqual([(previewOnly.digest as any).delegation_candidates, (previewOnly.digest as any).previewable.map((row: { action_id: string; match_rate: number }) => [row.action_id, row.match_rate])], [[], [["note.add", 0.9]]]);
  await seedCompared(s, qualified.body.qualification_id, 50, "match");
  const earned = await review();
  assert.deepEqual([(earned.digest as any).delegation_candidates.map((row: { action_id: string }) => row.action_id), (earned.digest as any).previewable], [["note.add"], []]);
});

test("the preview replays the counted decisions in the order they were proposed, not compared", async () => {
  const s = setup(true);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-order");
  const run = await s.run();
  const base = Date.parse(s.now());
  // Proposed at 0, 90 and 100 minutes; compared last-first-middle.
  for (const [id, proposedMin, comparedMin] of [["o3", 100, 200], ["o1", 0, 201], ["o2", 90, 202]] as const) {
    s.db.raw
      .prepare(
        `INSERT INTO agent_shadow_steps (shadow_step_id,tenant_id,run_id,specialist_id,action_id,step_key,args_json,args_sha256,sources_json,policy_json,subject_aggregate,subject_id,proposed_at)
        VALUES (?, ?, ?, 'lead_concierge', 'note.add', ?, '{}', ?, '[]', '{}', NULL, NULL, ?)`,
      )
      .run(`sstep_${id}`, TENANT, run.run_id, id, "0".repeat(64), new Date(base + proposedMin * 60_000).toISOString());
    s.db.raw
      .prepare(
        `INSERT INTO agent_agreements (agreement_id,tenant_id,source,specialist_id,action_id,shadow_step_id,step_id,verdict,catastrophes_json,comparator,actual_json,compared_at)
        VALUES (?, ?, 'shadow', 'lead_concierge', 'note.add', ?, NULL, 'match', '[]', 'synthetic@1', NULL, ?)`,
      )
      .run(`agr_${id}`, TENANT, `sstep_${id}`, new Date(base + comparedMin * 60_000).toISOString());
  }
  s.tick(1_000);
  assert.equal((await s.close(run.run_id, closeV3({ qualification_ref: qualified.body.qualification_id }))).body.terminal, "completed");
  const one = { count: { max: 1, per: "hour" }, amount: null, recipients: null };
  const shown = (await s.app(`/specialists/lead_concierge/preview?action=note.add&ceiling=${encodeURIComponent(JSON.stringify(one))}`)).body;
  // At 0 it runs, at 90 it runs (the first left the hour), at 100 the hour is full.
  assert.deepEqual(shown.would_have_run, { ran: 2, ran_not_matching: 0, of: 3 });
});

test("the face reads each listed pair's delegation record, and a pair it already proposed is not listed again", async () => {
  const s = setup(true);
  const qualified = await s.app("/qualifications", { ...QUALIFIED, passed: true, report_sha256: "a".repeat(64) }, "owner", "qualify-record");
  await seedCompared(s, qualified.body.qualification_id, 49, "match");
  await seedCompared(s, qualified.body.qualification_id, 1, "diverge");
  const review = await WATCH_CONDITIONS.delegation_review.evaluate(s.db, TENANT, null, s.now());
  assert.deepEqual(review.objects, [{ aggregate: "delegation", id: "lead_concierge:note.add" }]);
  // The watch's run starts from that object and holds its record.
  const signal = await appendSignal(
    s.db,
    TENANT,
    { kind: "watch", specialist_id: "orchestrator", watch_id: "delegation_review", source: "watch_scheduler", subject: null, content: { watch_id: "delegation_review", period_key: "synthetic", objects: review.objects, digest: review.digest, summary: review.summary }, dedupe_key: "review-record" },
    s.now(),
  );
  assert.ok("signal_id" in signal);
  const opened = await s.worker.openRun({ signal_id: signal.signal_id, specialist_id: "orchestrator", host_run_key: "review-record-run" });
  const record = opened.context.facts.find((fact: { fact_id: string }) => fact.fact_id === "delegation/lead_concierge:note.add");
  assert.ok(record, JSON.stringify(opened.context.facts.map((fact: { fact_id: string }) => fact.fact_id)));
  assert.deepEqual(Object.keys(record.data).sort(), [
    "action_id", "bar", "failed_readback", "history", "most_proposed_in", "policy_version", "practice", "qualified", "release_sha256", "setting", "specialist_id", "window",
  ]);
  assert.deepEqual(
    [record.data.setting, record.data.policy_version, record.data.window.match_rate, record.data.bar.meets, record.data.qualified?.qualification_id, record.data.most_proposed_in],
    [{ setting: "within_limits", fallback: false, ceiling: null, setting_id: null, revision: null, set_by: null, set_at: null }, 5, 0.98, true, qualified.body.qualification_id, { hour: 50, day: 50, week: 50 }],
  );
  // Once the face proposes it, the next review lists it as awaiting the owner, not as a candidate.
  const proposed = (await s.propose({ run_id: opened.run_id, signal_id: signal.signal_id }, "delegation.propose_change", proposal())).body;
  assert.equal(proposed.decision, "drafted", JSON.stringify(proposed));
  const again = await WATCH_CONDITIONS.delegation_review.evaluate(s.db, TENANT, null, s.now());
  assert.deepEqual([(again.digest as any).delegation_candidates, (again.digest as any).awaiting_owner], [[], [{ specialist_id: "lead_concierge", action_id: "note.add" }]]);
  // The owner answers it (here: practice only); the pair can be proposed again.
  s.tick(1_000);
  assert.equal((await s.app("/specialists/lead_concierge/shadow", shadowBody(), "owner", "answer-proposal")).status, 200);
  assert.equal(((await WATCH_CONDITIONS.delegation_review.evaluate(s.db, TENANT, null, s.now())).digest as any).awaiting_owner.length, 0);
  // Any other id names no record.
  for (const id of ["lead_concierge", "lead_concierge:consent.record", "synthetic_nobody:note.add", "lead_concierge:note.add:extra", ":note.add"])
    assert.equal(await (await import("../src/agents/read-models.ts")).OBJECT_MODELS.delegation.read(s.db, TENANT, id), null, id);
});

test("only the owner's and ops' views read a delegation record, and the release-fallback read covers any run's life", async () => {
  const { viewFor } = await import("../src/agents/memory.ts");
  const { OBJECT_MODELS } = await import("../src/agents/read-models.ts");
  const { RUN_LIFETIME_BOUND_MS } = await import("../src/agents/shadow.ts");
  const { EXPIRY_GRACE_MS } = await import("../src/agents/store.ts");
  const { DEFAULT_CEILINGS } = await import("../src/agents/policy.ts");
  assert.deepEqual(
    [{ role: "owner" }, { role: "ops" }, { role: "sales" }, "orchestrator", "independent_auditor", "lead_concierge"].map((reader) => viewFor(OBJECT_MODELS, reader, "delegation") !== null),
    [true, true, false, true, true, false],
  );
  // A run closes within its wall time plus the cron's grace; the read looks back further than that.
  assert.ok(RUN_LIFETIME_BOUND_MS > DEFAULT_CEILINGS.wallTimeMs + EXPIRY_GRACE_MS + 3_600_000);
});

test("lead_concierge proposes an inquiry's details from the inbound it answers, citing only that inbound", async () => {
  const s = setup();
  const run = await s.run();
  const fields = { service: "metal_roofing", scope: null, address: "1 Synthetic Way", timing: "before the first snow" };
  const proposed = (await s.propose(run, "lead_fact.propose", { lead_id: "synthetic-lead", fields })).body;
  assert.deepEqual([proposed.decision, proposed.receipt.outcome, proposed.receipt.needs_from_you], ["drafted", "succeeded", null], JSON.stringify(proposed));
  // lead_fact.confirm names this step as its proposal.
  assert.ok(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(proposed.step_id));
  // A run started by an owner's ask is not an inbound: the same proposal stops.
  const asked = await s.run("lead_concierge", { kind: "owner_request", source: "ask:appu_test_owner", content: { text: "Synthetic ask" } });
  assert.deepEqual((await s.propose(asked, "lead_fact.propose", { lead_id: "synthetic-lead", fields })).body.reason_codes, ["out_of_scope"]);
});

test("the pair index serves the delegation reads, and only the face proposes delegation changes", async () => {
  const { CATALOG } = await import("../src/agents/catalog.ts");
  // proposalAwaitsOwner reads the face's steps only: a second owner would need that read widened.
  assert.deepEqual(CATALOG.actions.find((action) => action.action_id === "delegation.propose_change")?.owners, ["orchestrator"]);
  const s = setup(true);
  const plan = (sql: string) => (s.db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
  for (const sql of [
    "SELECT COUNT(*) FROM agent_run_steps WHERE tenant_id = 't' AND specialist_id = 's' AND action_id = 'a' AND created_at >= 'x' AND json_extract(permit_json, '$.kind') = 'within_limits'",
    "SELECT step_id FROM agent_run_steps WHERE tenant_id = 't' AND specialist_id = 's' AND action_id = 'a' AND json_extract(permit_json, '$.delegation_id') = 'd' LIMIT 1",
    "SELECT COUNT(*) FROM agent_run_steps s LEFT JOIN agent_step_decisions d ON d.step_id = s.step_id WHERE s.tenant_id = 't' AND s.specialist_id = 's' AND s.action_id = 'a'",
  ])
    assert.match(plan(sql), /idx_agent_run_steps_pair/, sql);
});
