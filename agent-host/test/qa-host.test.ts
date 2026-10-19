// The QA host end to end: the runner and the real gateway on config/gateway.consumer.json (the
// owner's personal sign-ins), fake providers, a Worker that sends no qualifications. A synthetic
// host runs every Worker run as a synthetic run; its business twin abstains. All data synthetic.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { loadGatewayConfig, type GatewayConfig } from "../src/gateway/config.ts";
import type { DataClass } from "../src/gateway/compliance.ts";
import { ProviderGateway } from "../src/gateway/gateway.ts";
import { specialistRelease } from "../src/host/release.ts";
import { runSignal, type RunnerOptions } from "../src/host/runner.ts";
import type { CloseModelV3, OpenedRun } from "../src/host/worker.ts";
import { CONSUMER_CONFIG_PATH, fakeAdapter, outcome, tempDir, type FakeAdapter } from "./helpers.ts";
import { RUN_OUTPUT, fakeWorker, openedRun, playbook, signal, specialistsRoot, type FakeWorker } from "./host-helpers.ts";

interface Host {
  options: RunnerOptions;
  gatewayState: string;
  claude: FakeAdapter;
  codex: FakeAdapter;
  env: Record<string, string | undefined>;
  root: string;
}

/** The lead concierge and the independent auditor, as synthetic specialists. */
function team(t: TestContext): string {
  const root = specialistsRoot(t);
  mkdirSync(join(root, "independent_auditor"));
  writeFileSync(join(root, "independent_auditor", "playbook.md"), playbook("independent_auditor", { tier: "audit" }));
  writeFileSync(
    join(root, "independent_auditor", "allowlist.json"),
    JSON.stringify({ schema_version: "ironwrap.specialist-allowlist.v1", specialist_id: "independent_auditor", catalog_sha256: "0".repeat(64), actions: [{ action_id: "lead.qualify", autonomy: "A1", purpose: "Review" }] }),
  );
  return root;
}

function host(t: TestContext, worker: FakeWorker, dataClass: DataClass, config: GatewayConfig = loadGatewayConfig(CONSUMER_CONFIG_PATH)): Host {
  const gatewayState = tempDir(t);
  const claude = fakeAdapter("claude");
  const codex = fakeAdapter("codex");
  codex.credentialState = { fingerprint: "codex-credential-1", refreshedAt: Date.now(), plan: "pro" };
  const env: Record<string, string | undefined> = {};
  const gateway = new ProviderGateway({ config, stateDir: gatewayState, env, dataClass, adapters: { claude, codex }, sleep: async () => {} });
  const root = team(t);
  const options: RunnerOptions = {
    gateway,
    worker,
    specialistsRoot: root,
    stateDir: tempDir(t),
    actionServer: (runId, actionIds) => ({ command: "node", args: ["agent-server.mjs"], env: { AGENT_RUN_ID: runId, AGENT_ALLOWED_ACTIONS: actionIds.join(",") }, passEnv: [] }),
    log: () => {},
    closeAttempts: 1,
    closeBackoffMs: 1,
  };
  return { options, gatewayState, claude, codex, env, root };
}

const ledger = (dir: string) => {
  const file = join(dir, "gateway-usage.jsonl");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
};
const auditSignal = signal({ signal_id: "sig_0002", specialist_id: "independent_auditor", subject: { aggregate: "coordination_run", id: "run_0000000001" } });
const auditRun = (provider: string): OpenedRun => openedRun({ run_id: "run_0000000002", review_of: { run_id: "run_0000000001", provider }, expected_action_id: null, mode: "live" });

test("a synthetic QA host serves live, shadow and audit runs on consumer accounts with no qualification, through every gate", async (t) => {
  const worker = fakeWorker(openedRun({ review_of: null, expected_action_id: null, mode: "live" }));
  const qa = host(t, worker, "synthetic");
  qa.codex.steps.push(outcome(RUN_OUTPUT), outcome(RUN_OUTPUT));
  qa.claude.steps.push(outcome(RUN_OUTPUT));

  // A live Worker run: the qualification gate does not apply, the consumer ref serves synthetic runs.
  assert.deepEqual(await runSignal(qa.options, signal()), { status: "ok", signal_id: "sig_0001", run_id: "run_0000000001", reason: null, closed: true });
  assert.deepEqual(worker.closed[0].body.model, { provider: "codex", model: "gpt-6.1-sol", models_used: [], auth_mode: "oauth", tier: "routine", route_id: "codex_sol", review_of: null, mode: "live" });

  // Its audit runs on the other family, and the close echoes the Worker's legacy hint.
  const auditing = fakeWorker(auditRun("codex"));
  const audit = await runSignal({ ...qa.options, worker: auditing }, auditSignal);
  assert.equal(audit.status, "ok");
  assert.deepEqual(auditing.closed[0].body.model, {
    provider: "claude",
    model: "claude-opus-5-5",
    models_used: [],
    auth_mode: "oauth",
    tier: "audit",
    route_id: "claude_opus",
    review_of: { run_id: "run_0000000001", provider: "codex" },
    mode: "live",
  });

  // A shadow run spends the shadow budget, as a synthetic run.
  const shadowing = fakeWorker(openedRun({ run_id: "run_0000000003", review_of: null, expected_action_id: null, mode: "shadow" }));
  assert.equal((await runSignal({ ...qa.options, worker: shadowing }, signal({ signal_id: "sig_0003" }))).status, "ok");

  const records = ledger(qa.gatewayState).filter((record) => record.calls === 1);
  assert.deepEqual(
    records.map((record) => [record.specialist, record.routeId, record.runClass, record.complianceRef]),
    [
      ["lead_concierge", "codex_sol", "synthetic", "ai.openai.chatgpt-consumer"],
      ["independent_auditor", "claude_opus", "synthetic", "ai.anthropic.claude-consumer"],
      ["shadow:lead_concierge", "codex_sol", "synthetic", "ai.openai.chatgpt-consumer"],
    ],
  );
});

test("the synthetic QA host keeps every other check: independence, model mismatch, the kill switch and the ceilings", async (t) => {
  // A review of work on a family the registry does not hold has no reviewer.
  const unknown = fakeWorker(auditRun("gemini"));
  const qa = host(t, unknown, "synthetic");
  await runSignal(qa.options, auditSignal);
  assert.deepEqual([unknown.closed[0].body.reason, unknown.closed[0].body.model], ["no_independent_route", null]);

  const worker = fakeWorker(openedRun({ review_of: null, expected_action_id: null, mode: "live" }));
  const mismatched = host(t, worker, "synthetic");
  mismatched.codex.steps.push({ ...outcome(RUN_OUTPUT), modelsUsed: ["gpt-5"] });
  await runSignal(mismatched.options, signal());
  assert.equal(worker.closed[0].body.reason, "model_mismatch");

  const killedWorker = fakeWorker();
  const killed = host(t, killedWorker, "synthetic");
  killed.env.AGENT_HOST_KILL = "1";
  await runSignal(killed.options, signal());
  assert.equal(killedWorker.closed[0].body.reason, "kill_switch");

  const config = loadGatewayConfig(CONSUMER_CONFIG_PATH);
  config.ceilings.specialists.lead_concierge = { calls: 1, costUsd: 40, costUsdPerCall: 3 };
  const capped = fakeWorker();
  const ceiling = host(t, capped, "synthetic", config);
  ceiling.codex.steps.push(outcome(RUN_OUTPUT));
  await runSignal(ceiling.options, signal());
  await runSignal(ceiling.options, signal({ signal_id: "sig_0009" }));
  assert.deepEqual(capped.closed.map((close) => close.body.reason), [null, "call_ceiling"]);
  assert.equal(ceiling.codex.calls.length, 1);
});

test("the business twin of the QA host abstains no_qualified_route before any provider call", async (t) => {
  for (const mode of ["live", "shadow"] as const) {
    const worker = fakeWorker(openedRun({ review_of: null, expected_action_id: null, mode }));
    const business = host(t, worker, "business");
    business.codex.steps.push(outcome(RUN_OUTPUT));
    const result = await runSignal(business.options, signal());
    assert.deepEqual([result.status, worker.closed[0].body.reason], ["abstained", "no_qualified_route"], mode);
    assert.match(worker.closed[0].body.detail ?? "", new RegExp(`no qualification of codex/gpt-6\\.1-sol at medium effort for release [0-9a-f]{12} of lead_concierge; ${mode} runs take qualified routes only`));
    assert.deepEqual([business.codex.calls.length, business.claude.calls.length, ledger(business.gatewayState)], [0, 0, []], mode);
  }
  // Even qualified, a business host never runs live work on a consumer account.
  const business = host(t, fakeWorker(), "business");
  const release = specialistRelease(business.root, "lead_concierge", "0".repeat(64)).release_sha256;
  const qualified = fakeWorker(
    openedRun({ review_of: null, expected_action_id: null, mode: "live", qualifications: [{ qualification_id: "qual-1", provider: "codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: release }] }),
  );
  await runSignal({ ...business.options, worker: qualified }, signal());
  assert.deepEqual([qualified.closed[0].body.reason, business.codex.calls.length], ["provider_disabled", 0]);
  assert.match(qualified.closed[0].body.detail ?? "", /codex is on ai\.openai\.chatgpt-consumer, which does not serve live runs/);
});

test("a Worker on the v3 close model gets the v3 block and its qualifications, and the run may use any provider", async (t) => {
  const qa = host(t, fakeWorker(), "synthetic");
  const release = specialistRelease(qa.root, "lead_concierge", "0".repeat(64)).release_sha256;
  const worker = fakeWorker(
    openedRun({
      review_of: null,
      expected_action_id: null,
      mode: "live",
      close_model: 3,
      qualifications: [
        { qualification_id: "qual-7", provider: "codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: release },
        // Malformed hints qualify nothing.
        { qualification_id: "qual-8", provider: "codex", model: "gpt-6.1-sol", effort: "turbo", release_sha256: release },
        { qualification_id: "qual-9", provider: "Codex", model: "gpt-6.1-sol", effort: "medium", release_sha256: release },
        null as never,
      ],
    }),
  );
  const requests: unknown[] = [];
  const gateway = qa.options.gateway;
  const recording = { run: (request: Parameters<typeof gateway.run>[0]) => (requests.push(request), gateway.run(request)) };
  qa.codex.steps.push(outcome(RUN_OUTPUT));
  await runSignal({ ...qa.options, gateway: recording, worker }, signal());
  const sent = requests[0] as { qualifications: unknown; providers?: unknown; release: string };
  assert.deepEqual(sent.qualifications, [{ id: "qual-7", provider: "codex", model: "gpt-6.1-sol", effort: "medium", release }]);
  assert.equal(sent.providers, undefined);
  const model = worker.closed[0].body.model as CloseModelV3;
  assert.deepEqual(model, {
    provider: "codex",
    adapter: "codex",
    family: "openai",
    model: "gpt-6.1-sol",
    effort: "medium",
    models_used: [],
    auth_mode: "oauth",
    billing: "subscription",
    tier: "routine",
    route_id: "codex_sol",
    route: "primary",
    failover: [],
    // A synthetic run needs no qualification, so it records none.
    qualification_ref: null,
    release_sha256: release,
    gateway_config_sha256: loadGatewayConfig(CONSUMER_CONFIG_PATH).sha256,
    review_of: null,
    mode: "live",
    compliance_ref: "ai.openai.chatgpt-consumer",
    run_class: "synthetic",
    risk_acceptance: null,
  });
  // A v3 review hint carries the family itself.
  const auditing = fakeWorker(openedRun({ run_id: "run_0000000002", review_of: { run_id: "run_0000000001", family: "openai" }, expected_action_id: null, mode: "live", close_model: 3 }));
  qa.claude.steps.push(outcome(RUN_OUTPUT));
  await runSignal({ ...qa.options, worker: auditing }, auditSignal);
  const reviewed = auditing.closed[0].body.model as CloseModelV3;
  assert.deepEqual([reviewed.provider, reviewed.family, reviewed.review_of], ["claude", "anthropic", { run_id: "run_0000000001", family: "openai" }]);
});
