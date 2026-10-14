#!/usr/bin/env node
// Per-run action surface for one specialist run. The provider CLI spawns this over stdio. It
// exposes the run's allowlisted catalog actions as tools and turns every call into a proposed
// step on the Worker, which alone decides whether the step is recorded, drafted, sent for
// approval, executed under a permit, or refused. It holds no authority and no provider credential.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const RUN_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ACTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CITATIONS_SCHEMA = {
  type: "array",
  maxItems: 40,
  description: "The exact facts this step relies on, by fact_id and the version you read.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["fact_id", "version"],
    properties: {
      fact_id: { type: "string", minLength: 1, maxLength: 160 },
      version: { type: "integer", minimum: 0 },
    },
  },
};

export function agentConfigFromEnv(env = process.env) {
  const baseUrl = normalizeBaseUrl(env.IRONWRAP_BUS_BASE_URL, env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true");
  const token = env.AGENT_HOST_WORKER_TOKEN?.trim();
  if (!token) throw new Error("AGENT_HOST_WORKER_TOKEN is required");
  const runId = env.AGENT_RUN_ID ?? "";
  if (!RUN_ID.test(runId)) throw new Error("AGENT_RUN_ID must be a run id");
  const allowed = new Set((env.AGENT_ALLOWED_ACTIONS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (allowed.size === 0 || [...allowed].some((id) => !ACTION_ID.test(id))) {
    throw new Error("AGENT_ALLOWED_ACTIONS must list catalog action ids");
  }
  const timeoutMs = Math.min(60_000, Math.max(1_000, Number.parseInt(env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS ?? "", 10) || 15_000));
  return { baseUrl, token, runId, allowed, timeoutMs };
}

/** The Worker's current tool list for the run, narrowed to the host's allowlisted action ids. */
export async function loadRunTools(config, fetchImpl = fetch) {
  const body = await workerRequest(config, fetchImpl, "GET", `/api/v1/agents/runs/${encodeURIComponent(config.runId)}/tools`);
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  return tools.filter(
    (tool) =>
      tool &&
      typeof tool.action_id === "string" &&
      typeof tool.tool_name === "string" &&
      TOOL_NAME.test(tool.tool_name) &&
      config.allowed.has(tool.action_id) &&
      tool.args_schema &&
      typeof tool.args_schema === "object",
  );
}

export function buildAgentServer(config, tools, fetchImpl = fetch) {
  const byName = new Map(tools.map((tool) => [tool.tool_name, tool]));
  const server = new Server({ name: "ironwrap-agent-actions", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.tool_name,
      description: `${tool.description} Autonomy ${tool.autonomy}. This proposes a step; the Worker decides whether it runs and answers with the decision.`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["args", "citations"],
        properties: { args: tool.args_schema, citations: CITATIONS_SCHEMA },
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) return failure("unknown_tool", `${request.params.name} is not an action of this run`);
    const input = request.params.arguments ?? {};
    if (typeof input !== "object" || Array.isArray(input) || !("args" in input) || !Array.isArray(input.citations)) {
      return failure("invalid_arguments", "call with { args, citations }");
    }
    // The same proposal sent twice (a retry after a timeout) carries the same key, so the Worker
    // answers it once.
    const step = { action_id: tool.action_id, args: input.args, citations: input.citations };
    const stepKey = createHash("sha256").update(canonicalJson(step)).digest("hex");
    try {
      const decision = await workerRequest(
        config,
        fetchImpl,
        "POST",
        `/api/v1/agents/runs/${encodeURIComponent(config.runId)}/steps`,
        { ...step, step_key: stepKey },
      );
      return { content: [{ type: "text", text: JSON.stringify(decision) }] };
    } catch (error) {
      return failure(error.code ?? "worker_unavailable", error.message);
    }
  });

  return server;
}

async function workerRequest(config, fetchImpl, method, path, body) {
  let response;
  try {
    response = await fetchImpl(config.baseUrl + path, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: "application/json",
        "user-agent": "ironwrap-agent-actions/0.1.0",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw codedError("worker_unavailable", `worker request failed: ${String(error?.name ?? "error")}`);
  }
  let parsed = null;
  try {
    const raw = await response.text();
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw codedError("worker_invalid_json", `worker answered ${response.status} without JSON`);
  }
  if (!response.ok) {
    const code = typeof parsed?.error === "string" ? parsed.error : `worker_http_${response.status}`;
    throw codedError(code, `worker refused the request: ${code}`);
  }
  return parsed;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function failure(code, message) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message }) }] };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeBaseUrl(raw, allowInsecureLocal) {
  if (!raw) throw new Error("IRONWRAP_BUS_BASE_URL is required");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash) throw new Error("IRONWRAP_BUS_BASE_URL must be a bare origin");
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && allowInsecureLocal && LOCAL_HOSTS.has(url.hostname)) return url.origin;
  throw new Error("IRONWRAP_BUS_BASE_URL must use HTTPS");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const config = agentConfigFromEnv();
  const tools = await loadRunTools(config);
  await buildAgentServer(config, tools).connect(new StdioServerTransport());
}
