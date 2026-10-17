// Live provider smoke: `npm run smoke`. One tiny structured call per routed tier through the real
// gateway, plus one audit of Codex-proposed work, which must run on Claude; it prints only status,
// route, provider, model, cost and abstention reason. It spends a few tokens of the configured
// sign-ins, so it is run by an operator, never by CI.

import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadGatewayConfig } from "../gateway/config.ts";
import { ProviderGateway } from "../gateway/gateway.ts";
import type { GatewayRequest, ProviderId } from "../gateway/types.ts";
import { applyLocalEnv, hostEnv } from "./env.ts";

applyLocalEnv(process.env);
const env = hostEnv({
  AGENT_HOST_WORKER_URL: "https://unused.example.invalid",
  AGENT_HOST_WORKER_TOKEN: "unused",
  AGENT_HOST_STATE_DIR: join(homedir(), ".config", "ironwrap", "agent-host-state"),
  ...process.env,
});
await mkdir(env.stateDir, { recursive: true, mode: 0o700 });
if (process.env.CODEX_HOME) await mkdir(process.env.CODEX_HOME, { recursive: true, mode: 0o700 });
const gateway = new ProviderGateway({ config: loadGatewayConfig(env.gatewayConfigPath), stateDir: env.stateDir, env: process.env });

const health = await gateway.health();
console.log(JSON.stringify({ ready: health.ready, alerts: health.alerts }));

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "echo"],
  properties: { ok: { type: "boolean" }, echo: { type: "string", maxLength: 40 } },
};
const call = { system: "Answer with the requested JSON only.", prompt: 'Return {"ok": true, "echo": "ironwrap-smoke"}.', outputSchema: schema };
const runs: Array<{ request: GatewayRequest; provider?: ProviderId }> = [
  { request: { specialist: "orchestrator", tier: "routine", ...call } },
  { request: { specialist: "orchestrator", tier: "hard", ...call } },
  { request: { specialist: "independent_auditor", tier: "audit", ...call } },
  // Work proposed on Codex is audited on the other family.
  { request: { specialist: "independent_auditor", tier: "audit", reviewOf: { runId: "smoke-run", provider: "codex" }, ...call }, provider: "claude" },
];

let failed = 0;
for (const { request, provider } of runs) {
  const result = await gateway.run(request);
  // A run must record the model it ran with (contract "Recorded on every run"); none is a failure.
  const ok =
    result.status === "ok" &&
    (result.output as { echo?: string }).echo === "ironwrap-smoke" &&
    result.modelsUsed.length > 0 &&
    (provider === undefined || result.provider === provider);
  if (!ok) failed += 1;
  console.log(
    JSON.stringify({
      tier: request.tier,
      review_of: result.reviewOf?.provider ?? null,
      status: result.status,
      route_id: result.routeId,
      provider: result.provider,
      model: result.model,
      models_used: result.modelsUsed,
      auth_mode: result.authMode,
      cost_usd: result.costUsd,
      duration_ms: result.durationMs,
      ...(result.status === "abstained" ? { reason: result.reason, detail: result.detail } : {}),
    }),
  );
}
process.exit(failed === 0 ? 0 : 1);
