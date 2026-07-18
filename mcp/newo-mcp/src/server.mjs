#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_ROLE_POLICY_PATH = fileURLToPath(
  new URL("../../../hermes/agents/roles.json", import.meta.url),
);

const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const boundedIdn = z.string().trim().min(1).max(128);
const actorListSchema = {
  integration_idn: boundedIdn,
  connector_idn: boundedIdn,
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
};
const userActorSchema = z.object({
  name: z.string().trim().min(1).max(256),
  external_id: z.string().trim().min(1).max(256),
  integration_idn: boundedIdn,
  connector_idn: boundedIdn,
  time_zone_identifier: z.string().trim().min(1).max(128).optional(),
}).strict();
const chatMessageSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  command_act_id: providerId.optional(),
  external_event_id: z.string().trim().min(1).max(256).optional(),
  arguments: z.array(z.object({
    name: z.string().trim().min(1).max(128),
    value: z.string().max(4_000),
  }).strict()).max(25).optional(),
  uninterruptible: z.boolean().optional(),
}).strict();
const sessionUpdateSchema = z.object({
  session_type: z.string().trim().min(1).max(128).optional(),
  is_test: z.boolean().optional(),
  is_success: z.boolean().nullable().optional(),
  is_lead: z.boolean().optional(),
  comment: z.string().max(2_000).optional(),
  conversation_penalty: z.number().min(-100).max(100).optional(),
  need_follow_up: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_sales_opportunity: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "At least one session field is required");
const outgoingWebhookSchema = z.object({
  idn: boundedIdn,
  description: z.string().max(1_000).optional(),
  url: z.url().refine((value) => value.startsWith("https://"), "HTTPS is required"),
  connector_idn: boundedIdn,
  command_idns: z.array(z.string().trim().min(1).max(256)).max(100).nullable(),
}).strict();
const outgoingWebhookUpdateSchema = outgoingWebhookSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one webhook field is required",
);
const incomingWebhookSchema = z.object({
  idn: boundedIdn,
  description: z.string().max(1_000).optional(),
  connector_idn: boundedIdn,
  event_idns: z.array(z.string().trim().min(1).max(256)).max(100).nullable(),
  allowed_ips: z.array(z.string().trim().min(1).max(256)).max(100).nullable().optional(),
}).strict();
const incomingWebhookUpdateSchema = incomingWebhookSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one webhook field is required",
);
const newoControlActionSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("auth.token.revoke"), args: z.object({}).strict() }).strict(),
  z.object({
    operation: z.literal("agent_actor.create"),
    args: z.object({
      persona_id: z.string().trim().min(1).max(128),
      external_id: z.string().trim().min(1).max(256),
      integration_idn: boundedIdn,
      connector_idn: boundedIdn,
    }).strict(),
  }).strict(),
  z.object({ operation: z.literal("user_actor.create"), args: userActorSchema }).strict(),
  z.object({ operation: z.literal("user_actor.get_or_create"), args: userActorSchema }).strict(),
  z.object({
    operation: z.literal("user_actor.update"),
    args: z.object({
      actor_id: providerId,
      input: z.object({
        name: z.string().trim().min(1).max(256).optional(),
        time_zone_identifier: z.string().trim().min(1).max(128).optional(),
      }).strict().refine((value) => Object.keys(value).length > 0, "At least one actor field is required"),
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("user_actor.delete"),
    args: z.object({ actor_id: providerId }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("chat.user.send"),
    args: z.object({ user_actor_id: providerId, input: chatMessageSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("conversation.agent_message.send"),
    args: z.object({
      agent_actor_id: providerId,
      user_actor_ids: z.array(providerId).min(1).max(25),
      text: z.string().trim().min(1).max(10_000),
      external_event_id: z.string().trim().min(1).max(256).optional(),
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("session.update"),
    args: z.object({ session_id: providerId, input: sessionUpdateSchema }).strict(),
  }).strict(),
  z.object({ operation: z.literal("webhook.outgoing.create"), args: outgoingWebhookSchema }).strict(),
  z.object({
    operation: z.literal("webhook.outgoing.update"),
    args: z.object({ webhook_id: providerId, input: outgoingWebhookUpdateSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("webhook.outgoing.delete"),
    args: z.object({ webhook_id: providerId }).strict(),
  }).strict(),
  z.object({ operation: z.literal("webhook.incoming.create"), args: incomingWebhookSchema }).strict(),
  z.object({
    operation: z.literal("webhook.incoming.update"),
    args: z.object({ webhook_id: providerId, input: incomingWebhookUpdateSchema }).strict(),
  }).strict(),
  z.object({
    operation: z.literal("webhook.incoming.delete"),
    args: z.object({ webhook_id: providerId }).strict(),
  }).strict(),
]);

export function configFromEnv(env = process.env) {
  const baseUrl = normalizeBaseUrl(
    env.IRONWRAP_BUS_BASE_URL,
    env.IRONWRAP_BUS_ALLOW_INSECURE_LOCAL === "true",
  );
  if (!env.IRONWRAP_ADMIN_TOKEN) throw new Error("IRONWRAP_ADMIN_TOKEN is required");
  const rolePolicy = loadRolePolicy(env.HERMES_ROLE_POLICY_PATH || DEFAULT_ROLE_POLICY_PATH);
  const agentRole = env.HERMES_AGENT_ROLE;
  const runtimeRole = rolePolicy.roles?.[agentRole];
  if (!runtimeRole) throw new Error("HERMES_AGENT_ROLE must name a role in roles.json");
  return {
    baseUrl,
    adminToken: env.IRONWRAP_ADMIN_TOKEN,
    requestTimeoutMs: boundedInteger(env.NEWO_MCP_REQUEST_TIMEOUT_MS, 10_000, 1_000, 60_000),
    writeEnabled: env.NEWO_MCP_WRITE_ENABLED === "true",
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
    throw new Error(`hermes_role_policy_unreadable:${safeError(error)}`);
  }
  if (!policy || typeof policy !== "object" || !policy.roles || typeof policy.roles !== "object") {
    throw new Error("hermes_role_policy_invalid");
  }
  return policy;
}

export async function newoGet(config, path) {
  return await newoRequest(config, path);
}

export async function newoPost(config, path, body, requestId, acceptedStatuses = new Set([200])) {
  return await newoRequest(config, path, { method: "POST", body, requestId, acceptedStatuses });
}

async function newoRequest(
  config,
  path,
  { method = "GET", body, requestId, acceptedStatuses = new Set([200]) } = {},
) {
  const controller = new AbortController();
  const timeoutMs = config.requestTimeoutMs ?? 10_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(config.baseUrl + path, {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.adminToken}`,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "newo-mcp/0.1.0",
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`newo_mcp_timeout_${timeoutMs}ms`);
    throw new Error(`newo_mcp_network_error:${safeError(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  const raw = await response.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`newo_mcp_invalid_json_${response.status}`);
  }
  if (!acceptedStatuses.has(response.status)) {
    const code = typeof parsed?.error === "string" ? parsed.error : "worker_error";
    throw new Error(`newo_mcp_http_${response.status}:${code}`);
  }
  return parsed;
}

export function assertNewoWriteEnabled(config) {
  if (!config.writeEnabled) throw new Error("newo_mcp_write_disabled");
}

export function buildServer(config) {
  config = resolveRuntimeConfig(config);
  const mcpServer = new McpServer({ name: "newo-mcp", version: "0.1.0" });
  const server = createAuthorizedRegistrar(mcpServer, config);

  server.registerTool(
    "get_newo_health",
    {
      title: "Get Newo Health",
      description: "Read Newo enablement, API authentication, production configuration, booking/outbound gates, and owned synchronization counts.",
      inputSchema: {},
    },
    async () => textResult(await newoGet(config, "/admin/newo/health")),
  );

  server.registerTool(
    "list_newo_sessions",
    {
      title: "List Newo Sessions",
      description: "Read recent owned receptionist session snapshots without raw payload bodies.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 50 }) => textResult(await newoGet(config, `/admin/newo/sessions?limit=${limit}`)),
  );

  server.registerTool(
    "list_newo_control_actions",
    {
      title: "List Newo Control Actions",
      description: "Read recent Newo preview, approval, execution, and failure evidence without exact arguments or provider bodies.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 50 }) => textResult(await newoGet(config, `/admin/newo/control-actions?limit=${limit}`)),
  );

  server.registerTool(
    "list_newo_agent_actors",
    {
      title: "List Newo Agent Actors",
      description: "List bounded Newo agent actors for one integration and connector.",
      inputSchema: actorListSchema,
    },
    async (args) => textResult(await readOperation(config, "agent_actors.list", args)),
  );

  server.registerTool(
    "get_newo_agent_actor",
    {
      title: "Get Newo Agent Actor",
      description: "Read one Newo agent actor by provider ID.",
      inputSchema: { actor_id: providerId },
    },
    async (args) => textResult(await readOperation(config, "agent_actor.get", args)),
  );

  server.registerTool(
    "list_newo_user_actors",
    {
      title: "List Newo User Actors",
      description: "List bounded Newo user actors for one integration and connector.",
      inputSchema: actorListSchema,
    },
    async (args) => textResult(await readOperation(config, "user_actors.list", args)),
  );

  server.registerTool(
    "get_newo_user_actor",
    {
      title: "Get Newo User Actor",
      description: "Read one Newo user actor by provider ID.",
      inputSchema: { actor_id: providerId },
    },
    async (args) => textResult(await readOperation(config, "user_actor.get", args)),
  );

  server.registerTool(
    "get_newo_user_actor_by_external_id",
    {
      title: "Get Newo User Actor By External ID",
      description: "Resolve one Newo user actor through an explicit external, integration, and connector identity.",
      inputSchema: {
        external_id: z.string().trim().min(1).max(256),
        integration_idn: boundedIdn,
        connector_idn: boundedIdn,
      },
    },
    async (args) => textResult(await readOperation(config, "user_actor.get_external", args)),
  );

  server.registerTool(
    "get_newo_user_messages",
    {
      title: "Get Newo User Messages",
      description: "Poll bounded messages for one Newo user actor.",
      inputSchema: { user_actor_id: providerId, is_streaming: z.boolean().optional() },
    },
    async (args) => textResult(await readOperation(config, "chat.user.poll", args)),
  );

  server.registerTool(
    "get_newo_agent_messages",
    {
      title: "Get Newo Agent Messages",
      description: "Receive bounded messages for one Newo agent actor.",
      inputSchema: { agent_actor_id: providerId, is_streaming: z.boolean().optional() },
    },
    async (args) => textResult(await readOperation(config, "chat.agent.receive", args)),
  );

  server.registerTool(
    "get_newo_chat_history",
    {
      title: "Get Newo Chat History",
      description: "Read bounded Newo chat history for an explicit user or agent actor.",
      inputSchema: {
        user_actor_id: providerId.optional(),
        agent_actor_id: providerId.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async (args) => textResult(await readOperation(config, "chat.history", args)),
  );

  server.registerTool(
    "list_newo_conversation_acts",
    {
      title: "List Newo Conversation Acts",
      description: "Search bounded Newo conversation acts with typed filters.",
      inputSchema: {
        query: z.string().trim().min(1).max(512).optional(),
        user_person_id: providerId.optional(),
        user_actor_ids: z.array(providerId).max(50).optional(),
        agent_person_id: providerId.optional(),
        agent_actor_id: providerId.optional(),
        flow_idn: boundedIdn.optional(),
        skill_idn: z.array(boundedIdn).max(50).optional(),
        reference_idns: z.array(boundedIdn).max(50).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).max(10_000).optional(),
      },
    },
    async (args) => textResult(await readOperation(config, "conversations.acts.list", args)),
  );

  server.registerTool(
    "get_newo_conversation_act",
    {
      title: "Get Newo Conversation Act",
      description: "Read one Newo conversation act by provider ID.",
      inputSchema: { act_id: providerId },
    },
    async (args) => textResult(await readOperation(config, "conversations.act.get", args)),
  );

  server.registerTool(
    "get_newo_session_aggregates",
    {
      title: "Get Newo Session Aggregates",
      description: "Read Newo session aggregates for a bounded date range of at most 366 days.",
      inputSchema: {
        from_datetime: z.iso.datetime({ offset: true }),
        to_datetime: z.iso.datetime({ offset: true }),
        external_customer_ids: z.array(z.string().trim().min(1).max(256)).max(100).optional(),
      },
    },
    async (args) => textResult(await readOperation(config, "session.aggregates", args)),
  );

  server.registerTool(
    "list_newo_outgoing_webhooks",
    {
      title: "List Newo Outgoing Webhooks",
      description: "List configured Newo outgoing report webhooks.",
      inputSchema: {},
    },
    async () => textResult(await readOperation(config, "webhooks.outgoing.list", {})),
  );

  server.registerTool(
    "list_newo_incoming_webhooks",
    {
      title: "List Newo Incoming Webhooks",
      description: "List configured Newo incoming webhooks.",
      inputSchema: {},
    },
    async () => textResult(await readOperation(config, "webhooks.incoming.list", {})),
  );

  server.registerTool(
    "list_newo_analytics_logs",
    {
      title: "List Newo Analytics Logs",
      description: "Read a bounded page of Newo analytics logs with typed filters.",
      inputSchema: {
        page: z.number().int().min(1).max(10_000),
        per: z.number().int().min(1).max(100),
        from_datetime: z.iso.datetime({ offset: true }).optional(),
        to_datetime: z.iso.datetime({ offset: true }).optional(),
        levels: z.array(z.string().trim().min(1).max(256)).max(20).optional(),
        log_types: z.array(z.string().trim().min(1).max(256)).max(20).optional(),
        external_event_id: z.string().trim().min(1).max(256).optional(),
        user_actor_ids: z.array(providerId).max(100).optional(),
        agent_actor_ids: z.array(providerId).max(100).optional(),
        connector_idns: z.array(boundedIdn).max(100).optional(),
        flow_idns: z.array(boundedIdn).max(100).optional(),
        skill_idns: z.array(boundedIdn).max(100).optional(),
      },
    },
    async (args) => textResult(await readOperation(config, "analytics.logs", args)),
  );

  server.registerTool(
    "dry_run_newo_control_action",
    {
      title: "Dry Run Newo Control Action",
      description: "Store and sign an exact-argument preview for one enumerated Newo mutation. This does not call the provider.",
      inputSchema: {
        action: newoControlActionSchema,
        requested_by: z.string().trim().min(3).max(128),
      },
    },
    async ({ action, requested_by }) => textResult(await newoPost(
      config,
      "/admin/newo/control/preview",
      { action, requested_by },
      undefined,
      new Set([201]),
    )),
  );

  server.registerTool(
    "request_newo_control_approval",
    {
      title: "Request Newo Control Approval",
      description: "Approved-write: record the named human approval for one exact dry run and return its one-time signed approval receipt.",
      inputSchema: {
        run_id: z.uuid(),
        dry_run_receipt: z.string().min(32).max(16_384),
        approved_by: z.string().trim().min(3).max(128),
        request_text: z.string().trim().min(10).max(500),
      },
    },
    async ({ run_id, dry_run_receipt, approved_by, request_text }) => {
      assertNewoWriteEnabled(config);
      const result = await newoPost(config, "/admin/newo/control/approve", {
        dry_run_receipt,
        approved_by,
        reason: request_text,
      }, run_id);
      assertBoundResult(result, run_id, approved_by);
      return textResult(result);
    },
  );

  server.registerTool(
    "request_newo_control_action",
    {
      title: "Request Newo Control Action",
      description: "Approved-write: consume an exact dry-run and signed approval receipt once, then execute the bound Newo mutation through the Worker.",
      inputSchema: {
        run_id: z.uuid(),
        dry_run_receipt: z.string().min(32).max(16_384),
        approval_receipt: z.string().min(32).max(16_384),
        approved_by: z.string().trim().min(3).max(128),
      },
    },
    async ({ run_id, dry_run_receipt, approval_receipt, approved_by }) => {
      assertNewoWriteEnabled(config);
      const result = await newoPost(config, "/admin/newo/control/execute", {
        dry_run_receipt,
        approval_receipt,
      }, run_id);
      assertBoundResult(result, run_id, approved_by);
      return textResult(result);
    },
  );

  return mcpServer;
}

async function readOperation(config, operation, args) {
  return (await newoPost(config, "/admin/newo/read", { operation, args })).result;
}

function assertBoundResult(result, runId, approvedBy) {
  if (result?.action_id !== runId) throw new Error("newo_mcp_action_id_mismatch");
  if (result?.approved_by !== approvedBy) throw new Error("newo_mcp_approver_mismatch");
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

function roleTools(role) {
  return [...new Set([...(role.reads ?? []), ...(role.dry_run ?? []), ...(role.approved_write ?? [])])];
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
    throw new Error(`NEWO_MCP_REQUEST_TIMEOUT_MS must be an integer from ${min} to ${max}`);
  }
  return value;
}

function safeError(error) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

function textResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer(configFromEnv());
  await server.connect(new StdioServerTransport());
}
