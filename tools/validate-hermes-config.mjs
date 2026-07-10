#!/usr/bin/env node
// Validates hermes/agents/roles.json against the implemented MCP source inventory parsed from the
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
    const nextRegistration = src.indexOf("server.registerTool(", match.index + match[0].length);
    requestDefinitions.set(match[1], {
      definition: match[2],
      block: src.slice(match.index, nextRegistration === -1 ? src.length : nextRegistration),
      server: name,
    });
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
const frappeSource = serverSources.get("erpnext-roofing-mcp");
const approvedHelper = frappeSource.match(
  /export function approvedWriteInputSchema\(baseSchema\)[\s\S]*?return baseSchema\.extend\(approvalShape\)\.strict\(\);\n\}/,
)?.[0];
assert.ok(approvedHelper, "approvedWriteInputSchema must remain directly inspectable");
assert.match(approvedHelper, /request_text:\s*z\.string\(\)\.min\(1\)\.max\(4000\)/);
assert.match(approvedHelper, /approved_by:\s*z\.string\(\)\.min\(1\)\.max\(140\)/);
assert.match(approvedHelper, /run_id:\s*z\.string\(\)\.min\(8\)\.max\(128\)/);
assert.match(approvedHelper, /dry_run_receipt:\s*z\.string\(\)\.min\(32\)\.max\(4096\)/);
assert.match(approvedHelper, /approval_receipt:\s*z\.string\(\)\.min\(32\)\.max\(8192\)/);
assert.match(approvedHelper, /option\.extend\(approvalShape\)\.strict\(\)/,
  "approved discriminated schemas must reject unknown keys");
for (const [tool, { definition, block, server }] of requestDefinitions) {
  const usesApprovedSchema = /inputSchema:\s*approvedWriteInputSchema\(/.test(definition);
  if (!usesApprovedSchema) {
    assert.match(definition, /\brun_id\s*:/, `${tool} must require a caller-supplied run_id`);
    assert.match(definition, /\bapproved_by\s*:/, `${tool} must require approved_by`);
    if (server === "erpnext-roofing-mcp") {
      assert.match(definition, /\bdry_run_receipt\s*:/, `${tool} must require dry_run_receipt`);
      assert.match(definition, /\bapproval_receipt\s*:/, `${tool} must require approval_receipt`);
    } else {
      assert.match(definition, /\bapproval_token\s*:/, `${tool} must retain the bus replay approval token`);
    }
    assert.doesNotMatch(definition, /run_id\s*:[^\n]*optional\s*\(/,
      `${tool}.run_id must not be optional`);
  }
  if (server === "erpnext-roofing-mcp") {
    assert.match(block, /assertWriteApproved\(config,\s*args\)/,
      `${tool} must enforce the server write-enable and receipt-key gate`);
    assert.match(block, /executeAuditedWrite\(/,
      `${tool} must use the audited Frappe write executor`);
  }
}
assert.match(frappeSource, /const REQUEST_TO_DRY_RUN = Object\.freeze/,
  "Frappe MCP must own an explicit runtime request-to-dry-run pairing map");
assert.match(frappeSource, /function createAuthorizedRegistrar\(/,
  "Frappe MCP must register tools through runtime role authorization");
assert.match(frappeSource, /if \(!allowedTools\.has\(name\)\) return;/,
  "Frappe MCP must omit tools not granted to the configured role");
assert.match(frappeSource, /verifyDryRunReceipt\(/,
  "Frappe MCP must verify a server-issued preview receipt before a write");
assert.match(frappeSource, /verifyApprovalReceipt\(/,
  "Frappe MCP must verify an independently signed human approval receipt before a write");
assert.match(frappeSource, /site_id: config\.siteId/,
  "preview and approval receipts must be bound to the target Frappe site");
assert.match(frappeSource, /HERMES_AGENT_ROLE must name a role in roles\.json/,
  "Frappe MCP runtime must require a named role from canonical roles.json");
assert.match(frappeSource, /HERMES_APPROVER_ID is required when writes are enabled/,
  "Frappe MCP runtime must bind its approval key to one configured approver identity");
assert.match(frappeSource, /approval_approver_identity_mismatch/,
  "Frappe MCP must reject an approved_by identity not bound to the approval key");

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
  request_create_job_assignment: "dry_run_job_assignment",
  request_create_change_order: "dry_run_change_order",
  request_transition_change_order: "dry_run_change_order_transition",
  request_create_safety_plan: "dry_run_safety_plan",
  request_record_safety_acknowledgement: "dry_run_safety_acknowledgement",
  request_record_job_compliance: "dry_run_job_compliance_record",
  request_record_customer_decision: "dry_run_customer_decision",
  request_record_communication_consent: "dry_run_communication_consent",
  request_resolve_reconciliation: "dry_run_reconciliation_resolution",
  request_tenant_export: "dry_run_tenant_export",
};
assert.deepEqual(
  new Set(Object.keys(WRITE_PAIRS)), requests,
  "WRITE_PAIRS must cover exactly the request_* tools that exist (a new write tool needs a pair entry)",
);
for (const [req, dry] of Object.entries(WRITE_PAIRS)) {
  assert.ok(dryRuns.has(dry), `${req} maps to missing dry_run tool ${dry}`);
}

const NEW_STRICT_READS = new Set([
  "get_crew_profile", "list_crew_profiles",
  "get_job_assignment", "list_job_assignments_for_job",
  "get_change_order", "list_change_orders_for_job",
  "get_safety_plan", "list_safety_plans_for_job",
  "get_job_compliance_record", "list_job_compliance_records_for_job",
  "get_communication_consent", "list_communication_consents_for_job",
  "get_customer_decision", "list_customer_decisions_for_job",
  "get_contract_acceptance", "list_contract_acceptances_for_job",
  "get_integration_reconciliation", "list_integration_reconciliations_for_job",
  "get_tenant_export_run", "list_tenant_export_runs_for_tenant",
]);
for (const tool of NEW_STRICT_READS) {
  assert.ok(reads.has(tool), `missing committed-model strict read: ${tool}`);
  assert.equal(toolServer.get(tool), "erpnext-roofing-mcp", `${tool} must belong to the Frappe server`);
}

const frappeTools = new Set([...inventory].filter((tool) => toolServer.get(tool) === "erpnext-roofing-mcp"));
assert.equal(frappeTools.size, 111, "Frappe MCP inventory must stay at the reviewed 111-tool contract");
assert.equal([...frappeTools].filter((tool) => reads.has(tool)).length, 69,
  "Frappe MCP must expose 69 read tools");
assert.equal([...frappeTools].filter((tool) => dryRuns.has(tool)).length, 21,
  "Frappe MCP must expose 21 dry-run tools");
assert.equal([...frappeTools].filter((tool) => requests.has(tool)).length, 21,
  "Frappe MCP must expose 21 approved-write tools");
assert.equal(inventory.size, 118, "two-server Hermes inventory must stay at 118 tools");

// Contract Acceptance is evidence produced by the customer/provider, never an agent mutation.
assert.ok(reads.has("get_contract_acceptance") && reads.has("list_contract_acceptances_for_job"),
  "Contract Acceptance must remain inspectable");
assert.ok(![...dryRuns, ...requests].some((tool) => tool.includes("contract_acceptance")),
  "Contract Acceptance must not have dry-run or approved-write tools");
assert.doesNotMatch(frappeSource, /target:\s*\{\s*doctype:\s*"Contract Acceptance"/,
  "no approved write may target Contract Acceptance");
assert.ok(reads.has("get_crew_profile") && reads.has("list_crew_profiles"),
  "Crew Profile must remain inspectable");
assert.ok(![...dryRuns, ...requests].some((tool) => tool.includes("crew_profile")),
  "Crew Profile must not have dry-run or approved-write tools");
assert.doesNotMatch(frappeSource, /target:\s*\{\s*doctype:\s*"Crew Profile"/,
  "no approved write may target Crew Profile");
for (const [tool, meta] of requestDefinitions) {
  if (meta.server !== "erpnext-roofing-mcp") continue;
  assert.doesNotMatch(tool, /(?:send|invoice|payment)/,
    `${tool} must not expose customer-send or accounting mutation semantics`);
}
assert.doesNotMatch(
  frappeSource,
  /target:\s*\{\s*doctype:\s*"(?:Payment Milestone|Sales Invoice|Payment Entry|Purchase Invoice)"/,
  "no approved write may target accounting mirror or accounting doctypes",
);
assert.match(frappeSource, /function assertVerifiedEvidence\(/,
  "evidence-backed commands must require verified evidence provenance");
assert.match(frappeSource, /evidence\?\.sync_state !== "Verified"/,
  "evidence-backed commands must reject queued, rejected, and superseded evidence");
assert.match(frappeSource, /function assertActorAssignedToRoofJob\(/,
  "Field Companion reads must be checked against an active assignment");
assert.doesNotMatch(frappeSource, /approval_token/,
  "Frappe MCP must not retain the shared approval-token mutation path");

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

console.log(`ok ${roleNames.length} Hermes agent roles + manifest validated against ${inventory.size} implemented MCP tools`);
