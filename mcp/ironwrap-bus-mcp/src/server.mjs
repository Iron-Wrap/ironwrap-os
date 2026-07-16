#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_ROLE_POLICY_PATH = fileURLToPath(
  new URL("../../../hermes/agents/roles.json", import.meta.url),
);

export function configFromEnv(env = process.env) {
  const baseUrl = normalizeBaseUrl(
    env.IRONWRAP_BUS_BASE_URL,
    env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true",
  );
  const adminToken = env.IRONWRAP_ADMIN_TOKEN;
  const writeEnabled = env.IRONWRAP_BUS_WRITE_ENABLED === "true";
  const writeToken = env.IRONWRAP_BUS_WRITE_TOKEN ?? env.HERMES_WRITE_TOKEN;
  const rolePolicy = loadRolePolicy(env.HERMES_ROLE_POLICY_PATH || DEFAULT_ROLE_POLICY_PATH);
  const agentRole = env.HERMES_AGENT_ROLE;
  const runtimeRole = rolePolicy.roles?.[agentRole];
  if (!adminToken) throw new Error("IRONWRAP_ADMIN_TOKEN is required");
  if (!runtimeRole) throw new Error("HERMES_AGENT_ROLE must name a role in roles.json");
  const requestTimeoutMs = boundedInteger(env.IRONWRAP_BUS_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000);
  return {
    baseUrl,
    adminToken,
    writeEnabled,
    writeToken,
    requestTimeoutMs,
    agentRole,
    agentRoleTitle: runtimeRole.title,
    allowedTools: roleTools(runtimeRole),
  };
}

export function loadRolePolicy(policyPath = DEFAULT_ROLE_POLICY_PATH) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (error) {
    throw new Error(`hermes_role_policy_unreadable:${String(error).slice(0, 180)}`);
  }
  if (!policy || typeof policy !== "object" || !policy.roles || typeof policy.roles !== "object") {
    throw new Error("hermes_role_policy_invalid");
  }
  return policy;
}

export async function busGet(config, path) {
  return await busRequest(config, path);
}

export async function busPost(config, path, body, requestId) {
  return await busRequest(config, path, { method: "POST", body, requestId });
}

export async function busReadiness(config) {
  return await busRequest(config, "/ready", { acceptedStatuses: new Set([200, 503]) });
}

async function busRequest(
  config,
  path,
  { method = "GET", body, requestId, acceptedStatuses = new Set([200]) } = {},
) {
  const controller = new AbortController();
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(config.baseUrl + path, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.adminToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "ironwrap-bus-mcp/0.2.0",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`bus_timeout_${timeoutMs}ms`);
    throw new Error(`bus_network_error: ${safeError(error)}`);
  } finally {
    clearTimeout(timeout);
  }

  const raw = await res.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    if (!acceptedStatuses.has(res.status)) throw new Error(`bus_http_${res.status}: non_json_response`);
    throw new Error(`bus_invalid_json_${res.status}`);
  }
  if (!acceptedStatuses.has(res.status)) {
    throw new Error(`bus_http_${res.status}: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

export function assertWriteApproved(config, approvalToken) {
  if (!config.writeEnabled) throw new Error("bus_write_disabled");
  if (!config.writeToken) throw new Error("bus_write_token_required");
  if (approvalToken !== config.writeToken) throw new Error("approval_token_invalid");
}

export function buildServer(config) {
  config = resolveRuntimeConfig(config);
  const mcpServer = new McpServer({ name: "ironwrap-bus-mcp", version: "0.2.0" });
  const server = createAuthorizedRegistrar(mcpServer, config);

  server.registerTool(
    "get_bus_readiness",
    {
      title: "Get Bus Readiness",
      description: "Read dependency and configuration readiness. Returns the not-ready checks instead of hiding a 503.",
      inputSchema: {},
    },
    async () => text(await busReadiness(config)),
  );

  server.registerTool(
    "get_operational_status",
    {
      title: "Get Operational Status",
      description: "Read heartbeat freshness, work queues, open dead letters, Frappe errors, audit failures, and QuickBooks receipt freshness.",
      inputSchema: { audit_limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ audit_limit = 20 }) => text(await busGet(config, `/admin/status?audit_limit=${audit_limit}`)),
  );

  server.registerTool(
    "list_recent_envelopes",
    {
      title: "List Recent Envelopes",
      description: "Read recent canonical lead envelopes from the IronWrap bus.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 25 }) => text(await busGet(config, `/admin/envelopes?limit=${limit}`)),
  );

  server.registerTool(
    "get_envelope",
    {
      title: "Get Envelope",
      description: "Read one canonical lead envelope by envelope_id.",
      inputSchema: { envelope_id: z.string().min(1) },
    },
    async ({ envelope_id }) => text(await busGet(config, `/admin/envelope/${encodeURIComponent(envelope_id)}`)),
  );

  server.registerTool(
    "list_dead_letters",
    {
      title: "List Dead Letters",
      description: "Read unrecovered dead-letter rows from the IronWrap bus.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 25 }) => text(await busGet(config, `/admin/dead-letter?limit=${limit}`)),
  );

  server.registerTool(
    "list_measurement_intake_exceptions",
    {
      title: "List Measurement Intake Exceptions",
      description: "Read unmatched or retryable measurement reports that need an operator to review or assign them. Request-key hash fields and processing leases are not exposed.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 25 }) => text(await busGet(config, `/admin/measurements/exceptions?limit=${limit}`)),
  );

  server.registerTool(
    "dry_run_replay",
    {
      title: "Dry Run Replay",
      description: "Preview one dead envelope before an envelope-scoped replay. Bulk replay is intentionally not exposed to Hermes.",
      inputSchema: { envelope_id: envelopeIdSchema() },
    },
    async ({ envelope_id }) => {
      const result = await busGet(config, `/admin/envelope/${encodeURIComponent(envelope_id)}`);
      if (!result?.envelope) throw new Error("envelope_not_found");
      if (result.envelope.status !== "dead") throw new Error("envelope_not_dead");
      return text({
        would_write: false,
        selection: "targeted",
        envelope_id,
        current_status: result.envelope.status,
        required_tool: "request_replay",
        expected_transition: "dead -> pending_jn_push",
      });
    },
  );

  server.registerTool(
    "request_replay",
    {
      title: "Request Replay",
      description: "Approved-write: atomically re-drive one reviewed dead-letter envelope. Retries are compare-and-set safe; bulk replay is not exposed.",
      inputSchema: {
        envelope_id: envelopeIdSchema(),
        run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/),
        request_text: z.string().trim().min(10).max(500),
        approved_by: z.string().trim().min(3).max(128),
        approval_token: z.string().min(1),
      },
    },
    async ({ envelope_id, run_id, request_text, approved_by, approval_token }) => {
      assertWriteApproved(config, approval_token);
      return text(await busPost(config, "/admin/replay", {
        envelope_id,
        run_id,
        approved_by,
        reason: request_text,
      }, run_id));
    },
  );

  return mcpServer;
}

function resolveRuntimeConfig(config = {}) {
  const rolePolicy = config.rolePolicy ?? loadRolePolicy(config.rolePolicyPath ?? DEFAULT_ROLE_POLICY_PATH);
  const agentRole = config.agentRole ?? "owner-operator";
  const role = rolePolicy.roles?.[agentRole];
  if (!role) throw new Error("hermes_agent_role_unknown");
  return {
    ...config,
    agentRole,
    agentRoleTitle: config.agentRoleTitle ?? role.title,
    allowedTools: config.allowedTools ?? roleTools(role),
  };
}

function createAuthorizedRegistrar(mcpServer, config) {
  const allowedTools = new Set(config.allowedTools);
  const rawRegisterTool = mcpServer.registerTool.bind(mcpServer);
  return {
    registerTool(name, definition, handler) {
      if (!allowedTools.has(name)) return;
      rawRegisterTool(name, definition, handler);
    },
  };
}

function normalizeBaseUrl(raw, allowInsecureLocal) {
  if (!raw) throw new Error("IRONWRAP_BUS_BASE_URL is required");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("IRONWRAP_BUS_BASE_URL must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("IRONWRAP_BUS_BASE_URL must not include credentials, query, or fragment");
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local && allowInsecureLocal)) {
    throw new Error("IRONWRAP_BUS_BASE_URL must use HTTPS (HTTP is allowed only for explicit local development)");
  }
  return url.toString().replace(/\/+$/, "");
}

function boundedInteger(raw, fallback, min, max) {
  const value = Number(raw ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`IRONWRAP_BUS_REQUEST_TIMEOUT_MS must be an integer from ${min} to ${max}`);
  }
  return value;
}

function envelopeIdSchema() {
  return z.string().regex(/^ow_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
}

function roleTools(role) {
  return [...new Set([
    ...(role.reads ?? []),
    ...(role.dry_run ?? []),
    ...(role.approved_write ?? []),
  ])];
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer(configFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
