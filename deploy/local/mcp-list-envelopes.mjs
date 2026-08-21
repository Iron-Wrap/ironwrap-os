#!/usr/bin/env node
// Call `list_recent_envelopes` on the real ironwrap-bus MCP server over stdio and print what it
// returned.
//
// Leakage check 7 of docs/WHITE-LABEL-CLONE-PLAYBOOK.md is about what a TENANT HERMES PROFILE
// can see, so asking the bus admin API directly would prove the wrong thing: the MCP server is
// where the tenant's base URL, admin token and role allowlist are bound together, and it is that
// binding the check is about. This drives the shipped server exactly as a Hermes client would.
//
// Configuration comes from the environment the server itself reads (IRONWRAP_BUS_BASE_URL,
// IRONWRAP_ADMIN_TOKEN, HERMES_AGENT_ROLE), so pointing it at a tenant is pointing it at that
// tenant's Worker with that tenant's token and nothing else.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const serverDir = resolve(process.argv[2] ?? ".");

// This file lives outside the MCP package on purpose (it is a check, not a shipped tool), so
// the SDK has to be resolved from the package that depends on it rather than from here.
const requireFromServer = createRequire(join(serverDir, "package.json"));
const sdk = (subpath) => import(pathToFileURL(requireFromServer.resolve(subpath)).href);
const { Client } = await sdk("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = await sdk("@modelcontextprotocol/sdk/client/stdio.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(serverDir, "src", "server.mjs")],
  env: process.env,
  stderr: "ignore",
});

const client = new Client({ name: "tenant-leakage-check", version: "1.0.0" });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: "list_recent_envelopes", arguments: { limit: 25 } });
  for (const block of result.content ?? []) {
    if (block.type === "text") process.stdout.write(`${block.text}\n`);
  }
  if (result.isError) process.exitCode = 1;
} catch (error) {
  console.error(`mcp-list-envelopes failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
