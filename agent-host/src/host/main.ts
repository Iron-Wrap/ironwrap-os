// Entry point: `node src/host/main.ts`. Wires the gateway, the Worker client, the specialist
// runner and the health server, then runs until SIGTERM or SIGINT.

import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadGatewayConfig } from "../gateway/config.ts";
import { ProviderGateway } from "../gateway/gateway.ts";
import { actionServerSpec } from "./action-server.ts";
import { applyLocalEnv, hostEnv } from "./env.ts";
import { createHealthServer } from "./http.ts";
import { AgentHostService } from "./service.ts";
import { WorkerClient } from "./worker.ts";

const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version as string;

const localNames = applyLocalEnv(process.env);
const env = hostEnv(process.env);
await mkdir(env.stateDir, { recursive: true, mode: 0o700 });
// The provider CLIs write under HOME and CODEX_HOME; on a read-only image both live on the volume.
for (const dir of [process.env.HOME, process.env.CODEX_HOME]) if (dir) await mkdir(dir, { recursive: true, mode: 0o700 });
const gateway = new ProviderGateway({ config: loadGatewayConfig(env.gatewayConfigPath), stateDir: env.stateDir, env: process.env, dataClass: env.dataClass });
const worker = new WorkerClient({ baseUrl: env.workerUrl, token: env.workerToken, timeoutMs: 15_000 });
const log = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);

const service = new AgentHostService({
  gateway,
  worker,
  health: () => gateway.health(),
  specialistsRoot: env.specialistsRoot,
  stateDir: env.stateDir,
  hostId: env.hostId,
  version: VERSION,
  pollMs: env.pollMs,
  batchSize: env.batchSize,
  concurrency: env.concurrency,
  log,
  actionServer: (runId, actionIds) => actionServerSpec(env, runId, actionIds),
});

const server = createHealthServer(() => service.status());
server.listen(env.port, env.bind, () =>
  log({ event: "host_started", version: VERSION, bind: env.bind, port: env.port, data_class: env.dataClass, local_env_names: localNames }),
);
service.start();

const shutdown = async (signal: string) => {
  log({ event: "host_stopping", signal });
  server.close();
  await service.stop();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
