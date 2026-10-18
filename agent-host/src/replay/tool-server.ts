// Stdio action surface for one replayed run: `node src/replay/tool-server.ts <tool file>`. The
// provider CLI spawns it in place of mcp/ironwrap-bus-mcp/src/agent-server.mjs and sees the same
// tools, but every call is answered from the tool file by answerCall: nothing reaches the Worker,
// a provider or the network. Newline-delimited JSON-RPC 2.0 with the requests an MCP client sends
// to a tools server; notifications need no answer.

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { answerCall, listTools, type ToolFile } from "./case-run.ts";

// tools/list and tools/call are the same in every revision. As the MCP SDK does, accept the
// client's revision when it is known and offer the latest otherwise.
const REVISIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];

const path = process.argv[2];
if (!path) {
  process.stderr.write("usage: tool-server.ts <tool file>\n");
  process.exit(2);
}
const file = JSON.parse(readFileSync(path, "utf8")) as ToolFile;
if (file.schema_version !== "ironwrap.eval-tool-file.v1") throw new Error(`${path} is not a replay tool file`);

let steps = 0;
const send = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (line.trim() === "") continue;
  let message: { id?: unknown; method?: unknown; params?: Record<string, unknown> } | null;
  try {
    message = JSON.parse(line);
  } catch {
    send({ id: null, error: { code: -32700, message: "parse error" } });
    continue;
  }
  if (typeof message !== "object" || message === null || message.id === undefined || message.id === null || typeof message.method !== "string") continue;
  const { id, method } = message;
  const params = message.params ?? {};
  if (method === "initialize") {
    const asked = params.protocolVersion;
    const protocolVersion = typeof asked === "string" && REVISIONS.includes(asked) ? asked : REVISIONS[0];
    send({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "ironwrap-agent-actions", version: "0.1.0" } } });
  } else if (method === "ping") {
    send({ id, result: {} });
  } else if (method === "tools/list") {
    send({ id, result: { tools: listTools(file) } });
  } else if (method === "tools/call") {
    steps += 1;
    send({ id, result: answerCall(file, String(params.name), params.arguments ?? {}, steps) });
  } else {
    send({ id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
