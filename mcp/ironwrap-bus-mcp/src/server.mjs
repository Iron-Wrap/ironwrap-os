#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

export function configFromEnv(env = process.env) {
  const baseUrl = env.IRONWRAP_BUS_BASE_URL?.replace(/\/+$/, "");
  const adminToken = env.IRONWRAP_ADMIN_TOKEN;
  if (!baseUrl) throw new Error("IRONWRAP_BUS_BASE_URL is required");
  if (!adminToken) throw new Error("IRONWRAP_ADMIN_TOKEN is required");
  return { baseUrl, adminToken };
}

export async function busGet(config, path) {
  const res = await fetch(config.baseUrl + path, {
    headers: { authorization: `Bearer ${config.adminToken}`, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`bus_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return await res.json();
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
