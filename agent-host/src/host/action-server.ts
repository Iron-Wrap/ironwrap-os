// The stdio action server for one run. Shared by the host entry point and its contract test, so
// the variables the host sets and the variables mcp/ironwrap-bus-mcp/src/agent-server.mjs reads
// cannot drift apart.

import type { McpStdioServer } from "../gateway/types.ts";
import { WORKER_TOKEN_ENV, type HostEnv } from "./env.ts";

export function actionServerSpec(env: Pick<HostEnv, "actionServerPath" | "workerUrl" | "allowInsecureLocal">, runId: string, actionIds: string[]): McpStdioServer {
  return {
    command: process.execPath,
    args: [env.actionServerPath],
    env: {
      IRONWRAP_BUS_BASE_URL: env.workerUrl,
      IRONWRAP_BUS_ALLOW_INSECURE_LOCAL: String(env.allowInsecureLocal),
      AGENT_RUN_ID: runId,
      AGENT_ALLOWED_ACTIONS: actionIds.join(","),
    },
    passEnv: [WORKER_TOKEN_ENV],
  };
}
