// Host settings from the environment. Secrets are read by name here and passed on by name; none
// is logged or written to disk.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { DataClass } from "../gateway/compliance.ts";
import { parseWorkerUrl } from "./worker.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export const WORKER_TOKEN_ENV = "AGENT_HOST_WORKER_TOKEN";

/**
 * Local sign-ins, kept outside the repository: `~/.config/ironwrap/agent-host.env` holds KEY=value
 * lines (for example CLAUDE_CODE_OAUTH_TOKEN) and must be readable by its owner only, and the
 * dedicated Codex home defaults to `~/.config/ironwrap/codex`. Variables already set win, so a
 * production container's environment is never overridden. Returns the names loaded, never values.
 */
export function applyLocalEnv(env: Record<string, string | undefined>, home = homedir()): string[] {
  const file = env.AGENT_HOST_ENV_FILE?.trim() || join(home, ".config", "ironwrap", "agent-host.env");
  const loaded: string[] = [];
  if (existsSync(file)) {
    if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be readable by its owner only (chmod 600)`);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || line.trimStart().startsWith("#")) continue;
      const [, name, raw] = match;
      if (env[name] !== undefined && env[name] !== "") continue;
      // A quoted value is taken as is; an unquoted one ends at a whitespace-preceded `#` comment,
      // and so does anything after a closing quote.
      const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(raw);
      env[name] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
      loaded.push(name);
    }
  }
  if (!env.CODEX_HOME) {
    env.CODEX_HOME = join(home, ".config", "ironwrap", "codex");
    loaded.push("CODEX_HOME");
  }
  return loaded;
}

export interface HostEnv {
  stateDir: string;
  workerUrl: string;
  allowInsecureLocal: boolean;
  workerToken: string;
  bind: string;
  port: number;
  pollMs: number;
  batchSize: number;
  concurrency: number;
  gatewayConfigPath: string;
  specialistsRoot: string;
  actionServerPath: string;
  hostId: string;
  /**
   * `AGENT_HOST_DATA_CLASS`: what the Worker holds. `business` (the default) keeps live and shadow
   * runs to qualified routes on accounts whose terms allow them; `synthetic`, for a QA or dev host
   * on seed data, runs every Worker run as a synthetic run. Any other value refuses to start.
   */
  dataClass: DataClass;
}

export function hostEnv(env: Record<string, string | undefined>): HostEnv {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const allowInsecureLocal = env.AGENT_HOST_ALLOW_INSECURE_LOCAL === "true";
  const stateDir = required("AGENT_HOST_STATE_DIR");
  if (!isAbsolute(stateDir)) throw new Error("AGENT_HOST_STATE_DIR must be an absolute path");
  const bind = env.AGENT_HOST_BIND?.trim() || "127.0.0.1";
  if (bind !== "127.0.0.1" && bind !== "::1" && env.AGENT_HOST_BIND_PUBLIC !== "true") {
    throw new Error("AGENT_HOST_BIND must stay on loopback; publish health through the tunnel instead");
  }
  return {
    stateDir,
    workerUrl: parseWorkerUrl(required("AGENT_HOST_WORKER_URL"), allowInsecureLocal),
    allowInsecureLocal,
    workerToken: required(WORKER_TOKEN_ENV),
    bind,
    port: integer(env.AGENT_HOST_PORT, 8790, 1, 65_535),
    pollMs: integer(env.AGENT_HOST_POLL_MS, 15_000, 1_000, 600_000),
    batchSize: integer(env.AGENT_HOST_BATCH_SIZE, 20, 1, 200),
    concurrency: integer(env.AGENT_HOST_CONCURRENCY, 4, 1, 32),
    gatewayConfigPath: path(env.AGENT_HOST_GATEWAY_CONFIG, "config/gateway.json"),
    specialistsRoot: path(env.AGENT_HOST_SPECIALISTS_DIR, "specialists"),
    actionServerPath: path(env.AGENT_HOST_ACTION_SERVER, "../mcp/ironwrap-bus-mcp/src/agent-server.mjs"),
    hostId: env.AGENT_HOST_ID?.trim() || hostname(),
    dataClass: dataClass(env.AGENT_HOST_DATA_CLASS),
  };
}

function dataClass(raw: string | undefined): DataClass {
  const value = raw?.trim() || "business";
  if (value !== "business" && value !== "synthetic") throw new Error(`AGENT_HOST_DATA_CLASS must be business or synthetic, got ${value.slice(0, 40)}`);
  return value;
}

function path(raw: string | undefined, fallback: string): string {
  return resolve(PACKAGE_ROOT, raw?.trim() || fallback);
}

function integer(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`expected an integer from ${min} to ${max}, got ${raw}`);
  return value;
}
