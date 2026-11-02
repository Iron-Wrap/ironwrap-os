#!/usr/bin/env node
// Validates hermes/agents/roles.json against the implemented MCP source inventory parsed from the
// two role-filtered server sources, plus the fixed desktop-pilot manifest/source contract, and
// enforces the Hermes safety contract at config level:
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
  "newo-mcp": "mcp/newo-mcp/src/server.mjs",
};
const desktopServer = {
  name: "ironwrap-hermes-desktop-mcp",
  source: "mcp/ironwrap-bus-mcp/src/desktop-server.mjs",
  toolFilter: {
    read: ["hermes_next_tasks"],
    draft: ["hermes_stage_context", "hermes_submit_draft"],
  },
  env: [
    "IRONWRAP_BUS_BASE_URL",
    "IRONWRAP_HERMES_DESKTOP_PAIRING_URL",
    "IRONWRAP_HERMES_DESKTOP_ACCESS_TOKEN",
    "IRONWRAP_HERMES_DESKTOP_DEVICE_PROOF",
    "IRONWRAP_BUS_ALLOW_INSECURE_LOCAL",
    "IRONWRAP_BUS_REQUEST_TIMEOUT_MS",
  ],
};

// Implemented-source inventory: tool names from every registration path in the servers, i.e.
// direct server.registerTool("<name>", ...) plus the registerReadPair helper that
// registers a get/list pair via getName:/listName: fields.
const inventory = new Set();
const toolServer = new Map();
const requestDefinitions = new Map();
const serverSources = new Map();
const REGISTRATION_PATTERNS = [
  /registerTool\(\s*"([a-z0-9_]+)"/g,
  /\b(?:getName|listName):\s*"([a-z0-9_]+)"/g,
];
for (const [name, rel] of Object.entries(servers)) {
  const src = readFileSync(join(root, rel), "utf8");
  serverSources.set(name, src);
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
  for (const match of src.matchAll(/server\.registerTool\(\s*"(request_[a-z0-9_]+)"([\s\S]*?)\n\s*\},\n\s*async\s*\(/g)) {
    requestDefinitions.set(match[1], { definition: match[2], server: name });
  }
  assert.ok(count > 0, `no tools parsed from ${rel}`);
}

const reads = new Set([...inventory].filter((t) => /^(get|list|check)_/.test(t)));
const dryRuns = new Set([...inventory].filter((t) => t.startsWith("dry_run_")));
const requests = new Set([...inventory].filter((t) => t.startsWith("request_")));
// Sanity: the three buckets partition the inventory with nothing left over.
assert.equal(reads.size + dryRuns.size + requests.size, inventory.size,
  "every tool must be a read (get/list/check), a dry_run, or a request");

// The approval/audit identity is part of every mutation's public contract. A write without a
// caller-supplied stable run_id cannot be retried safely; a write without a server-issued
// dry-run receipt and an independently signed human approval receipt cannot prove the review
// gate was crossed.
assert.deepEqual(new Set(requestDefinitions.keys()), requests,
  "every request_* tool must be a directly inspectable registerTool definition");
const busSource = serverSources.get("ironwrap-bus-mcp");
const newoSource = serverSources.get("newo-mcp");
for (const [tool, { definition, server }] of requestDefinitions) {
  assert.match(definition, /\brun_id\s*:/, `${tool} must require a caller-supplied run_id`);
  assert.match(definition, /\bapproved_by\s*:/, `${tool} must require approved_by`);
  if (server === "ironwrap-bus-mcp") {
    assert.match(definition, /\bapproval_token\s*:/, `${tool} must retain the bus replay approval token`);
  } else {
    assert.match(definition, /\bdry_run_receipt\s*:/, `${tool} must require the exact Newo dry-run receipt`);
    if (tool === "request_newo_control_action") {
      assert.match(definition, /\bapproval_receipt\s*:/, `${tool} must require the signed approval receipt`);
    }
  }
  assert.doesNotMatch(definition, /run_id\s*:[^\n]*optional\s*\(/,
    `${tool}.run_id must not be optional`);
}
assert.match(busSource, /function createAuthorizedRegistrar\(/,
  "Bus MCP must register tools through runtime role authorization");
assert.match(busSource, /if \(!allowedTools\.has\(name\)\) return;/,
  "Bus MCP must omit tools not granted to the configured role");
assert.match(busSource, /HERMES_AGENT_ROLE must name a role in roles\.json/,
  "Bus MCP runtime must require a named role from canonical roles.json");
assert.match(newoSource, /function createAuthorizedRegistrar\(/,
  "Newo MCP must register tools through runtime role authorization");
assert.match(newoSource, /if \(!allowedTools\.has\(name\)\) return;/,
  "Newo MCP must omit tools not granted to the configured role");
assert.match(newoSource, /HERMES_AGENT_ROLE must name a role in roles\.json/,
  "Newo MCP runtime must require a named role from canonical roles.json");
assert.match(newoSource, /assertNewoWriteEnabled\(config\)/,
  "Newo MCP must retain an MCP-host write-enable gate in addition to Worker gates");
assert.match(newoSource, /assertBoundResult\(result, run_id, approved_by\)/,
  "Newo approval and execution results must be bound to the reviewed action and approver");
assert.doesNotMatch(newoSource, /NEWO_API_KEY|api\.newo\.ai/,
  "Newo MCP must never receive the provider key or call the provider directly");
assert.doesNotMatch(newoSource, /path\s*:\s*z\.|method\s*:\s*z\./,
  "Newo MCP must not expose a caller-controlled provider path or HTTP method");

// Canonical approved-write -> dry_run pairing. Names are not purely mechanical (both Newo
// approval and execution pair with one dry run), so the map is explicit and then checked to
// cover exactly the real request_* tools.
const WRITE_PAIRS = {
  request_replay: "dry_run_replay",
  request_newo_control_approval: "dry_run_newo_control_action",
  request_newo_control_action: "dry_run_newo_control_action",
};
assert.deepEqual(
  new Set(Object.keys(WRITE_PAIRS)), requests,
  "WRITE_PAIRS must cover exactly the request_* tools that exist (a new write tool needs a pair entry)",
);
for (const [req, dry] of Object.entries(WRITE_PAIRS)) {
  assert.ok(dryRuns.has(dry), `${req} maps to missing dry_run tool ${dry}`);
}

const newoTools = new Set([...inventory].filter((tool) => toolServer.get(tool) === "newo-mcp"));
assert.equal(newoTools.size, 20, "Newo MCP inventory must stay at the reviewed 20-tool contract");
assert.equal([...newoTools].filter((tool) => reads.has(tool)).length, 17,
  "Newo MCP must expose 17 bounded read tools");
assert.equal([...newoTools].filter((tool) => dryRuns.has(tool)).length, 1,
  "Newo MCP must expose one exact-argument dry-run tool");
assert.equal([...newoTools].filter((tool) => requests.has(tool)).length, 2,
  "Newo MCP must expose separate approval and receipt-consuming execution tools");
assert.equal(inventory.size, 28, "two-server Hermes inventory must stay at 28 tools");

const desktopSource = readFileSync(join(root, desktopServer.source), "utf8");
const desktopTools = new Set(
  [...desktopSource.matchAll(/\.registerTool\(\s*"([a-z0-9_]+)"/g)].map((match) => match[1]),
);
assert.deepEqual(
  desktopTools,
  new Set([...desktopServer.toolFilter.read, ...desktopServer.toolFilter.draft]),
  "desktop MCP must register exactly the three fixed pilot tools",
);

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

  const profile = readFileSync(join(root, `hermes/agents/${roleName}.md`), "utf8");
  const profileTools = (heading, nextHeading) => {
    const start = profile.indexOf(`## ${heading}`);
    const end = profile.indexOf(`## ${nextHeading}`, start + 1);
    assert.ok(start >= 0 && end > start, `${label} profile is missing ${heading}`);
    return new Set([...profile.slice(start, end).matchAll(/^- ([a-z0-9_]+)$/gm)].map((m) => m[1]));
  };
  assert.deepEqual(profileTools("Reads", "Dry-run"), new Set(role.reads),
    `${label} Markdown read list must exactly match roles.json`);
  assert.deepEqual(profileTools("Dry-run (preview)", "Approved-write"), new Set(role.dry_run),
    `${label} Markdown dry-run list must exactly match roles.json`);
  assert.deepEqual(profileTools("Approved-write", "Forbidden"), new Set(role.approved_write),
    `${label} Markdown approved-write list must exactly match roles.json`);
}

const fieldCompanionTools = new Set([
  ...config.roles["field-companion"].reads,
  ...config.roles["field-companion"].dry_run,
  ...config.roles["field-companion"].approved_write,
]);
for (const forbiddenTool of [
  "get_change_order", "list_change_orders_for_job",
  "get_customer_decision", "list_customer_decisions_for_job",
  "get_communication_consent", "list_communication_consents_for_job",
  "get_contract_acceptance", "list_contract_acceptances_for_job",
  "get_integration_reconciliation", "list_integration_reconciliations_for_job",
  "get_tenant_export_run", "list_tenant_export_runs_for_tenant",
  "request_create_change_order", "request_transition_change_order",
  "request_record_customer_decision", "request_record_communication_consent",
  "request_resolve_reconciliation", "request_tenant_export",
]) {
  assert.ok(!fieldCompanionTools.has(forbiddenTool),
    `field-companion must not receive commercial/admin tool ${forbiddenTool}`);
}

const financeTools = new Set([
  ...config.roles["finance-reconciler"].reads,
  ...config.roles["finance-reconciler"].dry_run,
  ...config.roles["finance-reconciler"].approved_write,
]);
for (const forbiddenTool of [
  "get_crew_profile", "list_crew_profiles",
  "get_job_assignment", "list_job_assignments_for_job",
  "get_safety_plan", "list_safety_plans_for_job",
  "get_job_compliance_record", "list_job_compliance_records_for_job",
  "get_communication_consent", "list_communication_consents_for_job",
  "get_customer_decision", "list_customer_decisions_for_job",
  "get_contract_acceptance", "list_contract_acceptances_for_job",
  "get_tenant_export_run", "list_tenant_export_runs_for_tenant",
  "request_tenant_export",
]) {
  assert.ok(!financeTools.has(forbiddenTool),
    `finance-reconciler must not receive field/customer/admin tool ${forbiddenTool}`);
}

// The launch manifest (hermes/mcp-servers.json) is the tool-filtering security boundary Hermes
// actually loads. Its per-server tool_filter must reference only real tools that belong to that
// server, be correctly bucketed, carry no literal secret values, and equal the UNION of what the
// roles grant on that server. A mismatch means a role could be granted a tool the runtime filters
// out, or the runtime could expose a tool no role should reach.
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
assert.ok(manifest.mcpServers, "mcp-servers.json missing mcpServers");
assert.deepEqual(
  new Set(Object.keys(manifest.mcpServers)),
  new Set([...Object.keys(servers), desktopServer.name]),
  "mcp-servers.json must declare exactly the two role-filtered servers and fixed desktop server",
);

// Union of role grants per server, derived from roles.json + which server owns each tool.
const roleUnion = {};
for (const s of Object.keys(servers)) roleUnion[s] = { read: new Set(), dry_run: new Set(), approved_write: new Set() };
for (const role of Object.values(config.roles)) {
  for (const [bucket, key] of [["reads", "read"], ["dry_run", "dry_run"], ["approved_write", "approved_write"]]) {
    for (const tool of role[bucket]) roleUnion[toolServer.get(tool)][key].add(tool);
  }
}

for (const [serverName, serverPath] of Object.entries(servers)) {
  const spec = manifest.mcpServers[serverName];
  const label = `mcp-servers.json[${serverName}]`;
  assert.equal(spec.command, "node", `${label} command must be node`);
  assert.equal(spec.args?.[0], serverPath, `${label} args must launch ${serverPath}`);
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
  for (const requiredRoleEnv of ["HERMES_AGENT_ROLE", "HERMES_ROLE_POLICY_PATH"]) {
    assert.equal(spec.env?.[requiredRoleEnv], `\${${requiredRoleEnv}}`,
      `${label}.env.${requiredRoleEnv} must bind the canonical runtime role policy`);
  }
}

const desktopSpec = manifest.mcpServers[desktopServer.name];
const desktopLabel = `mcp-servers.json[${desktopServer.name}]`;
assert.equal(desktopSpec.command, "node", `${desktopLabel} command must be node`);
assert.deepEqual(desktopSpec.args, [desktopServer.source],
  `${desktopLabel} must launch only ${desktopServer.source}`);
assert.deepEqual(desktopSpec.tool_filter, desktopServer.toolFilter,
  `${desktopLabel}.tool_filter must expose exactly the three fixed read/draft tools`);
assert.deepEqual(new Set(Object.keys(desktopSpec.env ?? {})), new Set(desktopServer.env),
  `${desktopLabel}.env must contain only the bounded desktop credential and transport names`);
for (const [key, value] of Object.entries(desktopSpec.env ?? {})) {
  assert.equal(value, `\${${key}}`, `${desktopLabel}.env.${key} must reference its matching placeholder`);
  assert.doesNotMatch(key, /ADMIN|WRITE|CONNECTOR|GMAIL|OUTLOOK|CALENDAR|DRIVE|TEAMS|SLACK/,
    `${desktopLabel}.env must not receive admin, write, or connector credentials`);
}
assert.ok(!("HERMES_AGENT_ROLE" in desktopSpec.env),
  `${desktopLabel} must stay outside the broad roles.json inventory`);

console.log(`ok ${roleNames.length} Hermes agent roles + ${inventory.size} role-filtered tools + 3 fixed desktop pilot tools validated`);
