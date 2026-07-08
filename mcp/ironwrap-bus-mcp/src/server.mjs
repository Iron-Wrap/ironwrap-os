#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function configFromEnv(env = process.env) {
  const baseUrl = env.IRONWRAP_BUS_BASE_URL?.replace(/\/+$/, "");
  const adminToken = env.IRONWRAP_ADMIN_TOKEN;
  const writeEnabled = env.IRONWRAP_BUS_WRITE_ENABLED === "true";
  const writeToken = env.IRONWRAP_BUS_WRITE_TOKEN ?? env.HERMES_WRITE_TOKEN;
  if (!baseUrl) throw new Error("IRONWRAP_BUS_BASE_URL is required");
  if (!adminToken) throw new Error("IRONWRAP_ADMIN_TOKEN is required");
  return { baseUrl, adminToken, writeEnabled, writeToken };
}

export async function busGet(config, path) {
  const res = await fetch(config.baseUrl + path, {
    headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`bus_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

export async function busPost(config, path) {
  const res = await fetch(config.baseUrl + path, {
    method: "POST",
    headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`bus_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
}

export function assertWriteApproved(config, approvalToken) {
  if (!config.writeEnabled) throw new Error("bus_write_disabled");
  if (!config.writeToken) throw new Error("bus_write_token_required");
  if (approvalToken !== config.writeToken) throw new Error("approval_token_invalid");
}

export function buildServer(config) {
  const server = new McpServer({ name: "ironwrap-bus-mcp", version: "0.1.0" });

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
    "dry_run_replay",
    {
      title: "Dry Run Replay",
      description: "Preview unrecovered dead-letter rows before re-driving them.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional() },
    },
    async ({ limit = 25 }) => {
      const deadLetters = await busGet(config, `/admin/dead-letter?limit=${limit}`);
      return text({ would_write: false, required_tool: "request_replay", dead_letters: deadLetters });
    },
  );

  server.registerTool(
    "request_replay",
    {
      title: "Request Replay",
      description: "Approved-write: re-drive dead-lettered envelopes through the bus queue.",
      inputSchema: {
        request_text: z.string().min(1).max(4000),
        approved_by: z.string().min(1),
        approval_token: z.string().min(1),
      },
    },
    async ({ approval_token }) => {
      assertWriteApproved(config, approval_token);
      return text(await busPost(config, "/admin/replay"));
    },
  );

  return server;
}

function text(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = buildServer(configFromEnv());
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
