// Live provider smoke: `npm run smoke`. One tiny structured call per routed tier, plus one audit of
// openai-proposed work, which must run on another family; it prints only status, route, provider,
// model, cost and abstention reason. It runs through an eval gateway on synthetic data under
// `<state>/smoke`, so it needs no qualification and books only its own eval ledger, never the
// production one. It spends a few tokens of the configured sign-ins, so an operator runs it, never CI.

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGatewayConfig } from "../gateway/config.ts";
import { ProviderGateway } from "../gateway/gateway.ts";
import type { GatewayRequest } from "../gateway/types.ts";
import { applyLocalEnv, hostEnv } from "./env.ts";

applyLocalEnv(process.env);
const env = hostEnv({
  AGENT_HOST_WORKER_URL: "https://unused.example.invalid",
  AGENT_HOST_WORKER_TOKEN: "unused",
  AGENT_HOST_STATE_DIR: join(homedir(), ".config", "ironwrap", "agent-host-state"),
  ...process.env,
});
const stateDir = join(env.stateDir, "smoke");
await mkdir(stateDir, { recursive: true, mode: 0o700 });
if (process.env.CODEX_HOME) await mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
const { ledger, judge } = JSON.parse(readFileSync(new URL("../../evals/qualification.v1.json", import.meta.url), "utf8")) as { ledger: unknown; judge: unknown };
const gateway = new ProviderGateway({ config: loadGatewayConfig(env.gatewayConfigPath), stateDir, env: process.env, qualification: { ledger, judge } });

const health = await gateway.health();
console.log(JSON.stringify({ ready: health.ready, alerts: health.alerts }));

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "echo"],
  properties: { ok: { type: "boolean" }, echo: { type: "string", maxLength: 40 } },
};
const call = {
  scope: "eval",
  data: "synthetic",
  system: "Answer with the requested JSON only.",
  prompt: 'Return {"ok": true, "echo": "ironwrap-smoke"}.',
  outputSchema: schema,
} as const;
const runs: Array<{ request: GatewayRequest; offFamily?: string }> = [
  { request: { specialist: "orchestrator", tier: "routine", ...call } },
  { request: { specialist: "orchestrator", tier: "hard", ...call } },
  { request: { specialist: "independent_auditor", tier: "audit", ...call } },
  // Work proposed on the openai family is audited on another family.
  { request: { specialist: "independent_auditor", tier: "audit", reviewOf: { runId: "smoke-run", family: "openai" }, ...call }, offFamily: "openai" },
];

let failed = 0;
for (const { request, offFamily } of runs) {
  const result = await gateway.run(request);
  // A run must record the model it ran with (contract "Recorded on every run"); none is a failure.
  const ok =
    result.status === "ok" &&
    (result.output as { echo?: string }).echo === "ironwrap-smoke" &&
    result.modelsUsed.length > 0 &&
    (offFamily === undefined || (result.family !== null && result.family !== offFamily));
  if (!ok) failed += 1;
  console.log(
    JSON.stringify({
      tier: request.tier,
      review_of: result.reviewOf?.family ?? null,
      status: result.status,
      route_id: result.routeId,
      provider: result.provider,
      family: result.family,
      model: result.model,
      models_used: result.modelsUsed,
      auth_mode: result.authMode,
      compliance_ref: result.complianceRef,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
      ...(result.status === "abstained" ? { reason: result.reason, detail: result.detail } : {}),
    }),
  );
}
process.exit(failed === 0 ? 0 : 1);
