#!/usr/bin/env node
// Validates hermes/agents/roles.json against the LIVE MCP tool inventory parsed from the
// two server sources, and enforces the Hermes safety contract at config level:
//   - every referenced tool actually exists in a server
//   - reads are read-only, dry_run are previews, approved_write are request_* mutations
//   - every approved_write tool carries its dry_run counterpart in the same role
//     (read -> dry_run -> approval -> write -> audit cannot be skipped)
//   - the canonical write-pair map exactly covers the real request_* tools
//   - all eight blueprint agent roles are present, no duplicate grants
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const rolesPath = join(root, "hermes/agents/roles.json");
const manifestPath = join(root, "hermes/mcp-servers.json");
const servers = {
  "ironwrap-bus-mcp": "mcp/ironwrap-bus-mcp/src/server.mjs",
  "erpnext-roofing-mcp": "mcp/erpnext-roofing-mcp/src/server.mjs",
};

// Live inventory: tool names from every registration path in the servers, i.e.
// direct server.registerTool("<name>", ...) plus the registerReadPair helper that
// registers a get/list pair via getName:/listName: fields.
const inventory = new Set();
const toolServer = new Map();
const REGISTRATION_PATTERNS = [
  /registerTool\(\s*"([a-z0-9_]+)"/g,
  /\b(?:getName|listName):\s*"([a-z0-9_]+)"/g,
];
for (const [name, rel] of Object.entries(servers)) {
  const src = readFileSync(join(root, rel), "utf8");
  let count = 0;
  for (const pattern of REGISTRATION_PATTERNS) {
    for (const m of src.matchAll(pattern)) {
      const tool = m[1];
      assert.ok(!inventory.has(tool), `duplicate tool across servers: ${tool}`);
      inventory.add(tool);
      toolServer.set(tool, name);
      count++;
    }
  }
  assert.ok(count > 0, `no tools parsed from ${rel}`);
}

const reads = new Set([...inventory].filter((t) => /^(get|list|check)_/.test(t)));
const dryRuns = new Set([...inventory].filter((t) => t.startsWith("dry_run_")));
const requests = new Set([...inventory].filter((t) => t.startsWith("request_")));
// Sanity: the three buckets partition the inventory with nothing left over.
assert.equal(reads.size + dryRuns.size + requests.size, inventory.size,
  "every tool must be a read (get/list/check), a dry_run, or a request");

// Canonical approved-write -> dry_run pairing. Names are not purely mechanical
// (request_create_material_takeoff pairs with dry_run_material_takeoff), so the map is
// explicit and then checked to cover exactly the real request_* tools.
const WRITE_PAIRS = {
  request_replay: "dry_run_replay",
  request_update_gate: "dry_run_update_gate",
  request_create_material_takeoff: "dry_run_material_takeoff",
  request_update_material_takeoff_status: "dry_run_update_material_takeoff_status",
  request_create_supplier_order: "dry_run_supplier_order",
  request_create_supplier_quote: "dry_run_supplier_quote",
  request_create_proposal_evidence_pack: "dry_run_proposal_evidence_pack",
  request_create_completion_packet: "dry_run_completion_packet",
  request_create_warranty_packet: "dry_run_warranty_packet",
  request_create_review_request: "dry_run_review_request",
  request_record_communication_event: "dry_run_communication_event",
  request_add_market_watch_item: "dry_run_market_watch_item",
};
assert.deepEqual(
  new Set(Object.keys(WRITE_PAIRS)), requests,
  "WRITE_PAIRS must cover exactly the request_* tools that exist (a new write tool needs a pair entry)",
);
for (const [req, dry] of Object.entries(WRITE_PAIRS)) {
  assert.ok(dryRuns.has(dry), `${req} maps to missing dry_run tool ${dry}`);
}

const REQUIRED_ROLES = [
  "owner-operator", "lead-concierge", "estimator-assistant", "production-controller",
  "field-companion", "finance-reconciler", "closeout-agent", "support-admin",
];

const config = JSON.parse(readFileSync(rolesPath, "utf8"));
const roleNames = Object.keys(config.roles ?? {});
for (const r of REQUIRED_ROLES) assert.ok(roleNames.includes(r), `missing agent role: ${r}`);
assert.deepEqual(new Set(roleNames), new Set(REQUIRED_ROLES), "unexpected or missing agent roles");

for (const [roleName, role] of Object.entries(config.roles)) {
  const label = `role ${roleName}`;
  assert.ok(role.title && role.summary, `${label} needs title + summary`);
  for (const key of ["reads", "dry_run", "approved_write", "forbidden"]) {
    assert.ok(Array.isArray(role[key]), `${label}.${key} must be an array`);
  }

  const seen = new Set();
  for (const bucket of ["reads", "dry_run", "approved_write"]) {
    for (const tool of role[bucket]) {
      assert.ok(inventory.has(tool), `${label}.${bucket} references unknown tool: ${tool}`);
      assert.ok(!seen.has(tool), `${label} grants ${tool} more than once`);
      seen.add(tool);
    }
  }
  for (const tool of role.reads) assert.ok(reads.has(tool), `${label}.reads has non-read tool: ${tool}`);
  for (const tool of role.dry_run) assert.ok(dryRuns.has(tool), `${label}.dry_run has non-preview tool: ${tool}`);
  for (const tool of role.approved_write) {
    assert.ok(requests.has(tool), `${label}.approved_write has non-request tool: ${tool}`);
    // The safety invariant: no write without its preview in the same role.
    const pair = WRITE_PAIRS[tool];
    assert.ok(role.dry_run.includes(pair),
      `${label} grants ${tool} but is missing its dry_run counterpart ${pair}`);
  }
  assert.ok(role.forbidden.length > 0, `${label} must state at least one forbidden boundary`);
}

// The launch manifest (hermes/mcp-servers.json) is the tool-filtering security boundary Hermes
// actually loads. Its per-server tool_filter must reference only real tools that belong to that
// server, be correctly bucketed, carry no literal secret values, and equal the UNION of what the
// roles grant on that server. A mismatch means a role could be granted a tool the runtime filters
// out, or the runtime could expose a tool no role should reach.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.ok(manifest.mcpServers, "mcp-servers.json missing mcpServers");
assert.deepEqual(new Set(Object.keys(manifest.mcpServers)), new Set(Object.keys(servers)),
  "mcp-servers.json must declare exactly the two known servers");

// Union of role grants per server, derived from roles.json + which server owns each tool.
const roleUnion = {};
for (const s of Object.keys(servers)) roleUnion[s] = { read: new Set(), dry_run: new Set(), approved_write: new Set() };
for (const role of Object.values(config.roles)) {
  for (const [bucket, key] of [["reads", "read"], ["dry_run", "dry_run"], ["approved_write", "approved_write"]]) {
    for (const tool of role[bucket]) roleUnion[toolServer.get(tool)][key].add(tool);
  }
}

for (const [serverName, spec] of Object.entries(manifest.mcpServers)) {
  const label = `mcp-servers.json[${serverName}]`;
  assert.equal(spec.args?.[0], servers[serverName], `${label} args must launch ${servers[serverName]}`);
  const filter = spec.tool_filter ?? {};
  for (const [bucket, membership] of [["read", reads], ["dry_run", dryRuns], ["approved_write", requests]]) {
    const listed = filter[bucket] ?? [];
    for (const tool of listed) {
      assert.ok(inventory.has(tool), `${label}.${bucket} references unknown tool: ${tool}`);
      assert.equal(toolServer.get(tool), serverName, `${label}.${bucket} lists ${tool} from the wrong server`);
      assert.ok(membership.has(tool), `${label}.${bucket} has a mis-bucketed tool: ${tool}`);
    }
    assert.deepEqual(new Set(listed), roleUnion[serverName][bucket],
      `${label}.${bucket} must equal the union of role grants on this server`);
  }
  // No literal secrets: env values must be ${PLACEHOLDER} references only.
  for (const [k, v] of Object.entries(spec.env ?? {})) {
    assert.match(String(v), /^\$\{[A-Z0-9_]+\}$/, `${label}.env.${k} must be a \${ENV} placeholder, not a literal value`);
  }
}

console.log(`ok ${roleNames.length} Hermes agent roles + manifest validated against ${inventory.size} live MCP tools`);
