#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tenantDir = join(root, "config", "tenants");

const requiredAreas = [
  "tenant",
  "brand",
  "geography",
  "services",
  "materials",
  "estimates",
  "proposal",
  "production",
  "communications",
  "integrations",
  "agents",
  "market_defense",
];

const knownGates = ["Deposit", "Materials", "Safety", "Access", "Weather", "Crew", "Completion"];

// Secret-looking string values must never appear in tenant configs; only env var NAMES are allowed.
const secretPatterns = [
  { name: "sk- style key", re: /\bsk-[A-Za-z0-9]{8,}/ },
  { name: "inline api key assignment", re: /api[_-]?key\s*[:=]\s*['"]?[A-Za-z0-9]/i },
  { name: "bearer token", re: /\bbearer\s+[A-Za-z0-9._\-\/+=]{8,}/i },
  { name: "long hex blob", re: /\b[0-9a-fA-F]{32,}\b/ },
  { name: "long base64 blob", re: /[A-Za-z0-9+\/]{40,}={0,2}/ },
  { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

const files = readdirSync(tenantDir).filter((f) => f.endsWith(".json")).sort();
assert.ok(files.length > 0, `no tenant configs found in ${tenantDir}`);

const tenants = files.map((file) => ({ file, doc: JSON.parse(readFileSync(join(tenantDir, file), "utf8")) }));

for (const { file, doc } of tenants) {
  for (const area of requiredAreas) {
    assert.ok(doc[area] !== undefined && doc[area] !== null, `${file} missing area: ${area}`);
  }

  assert.equal(typeof doc.tenant.id, "string", `${file} tenant.id must be a string`);
  assert.ok(doc.tenant.id.length > 0, `${file} tenant.id must be non-empty`);
  assert.equal(typeof doc.tenant.display_name, "string", `${file} tenant.display_name must be a string`);
  assert.equal(typeof doc.tenant.status, "string", `${file} tenant.status must be a string`);

  const compliance = doc.geography?.compliance;
  assert.ok(compliance, `${file} missing geography.compliance`);
  assert.equal(compliance.casl_consent_required, true, `${file} casl_consent_required must be true`);

  const qh = compliance.quiet_hours;
  assert.ok(qh, `${file} missing geography.compliance.quiet_hours`);
  assert.ok(Number.isInteger(qh.start_hour) && qh.start_hour >= 0 && qh.start_hour <= 23, `${file} quiet_hours.start_hour out of range`);
  assert.ok(Number.isInteger(qh.end_hour) && qh.end_hour >= 0 && qh.end_hour <= 23, `${file} quiet_hours.end_hour out of range`);
  assert.ok(qh.start_hour < qh.end_hour, `${file} quiet_hours start must be before end`);
  assert.equal(typeof qh.timezone, "string", `${file} quiet_hours.timezone must be a string`);

  const instant = doc.estimates?.instant_estimate;
  assert.ok(instant, `${file} missing estimates.instant_estimate`);
  assert.equal(instant.non_binding, true, `${file} instant_estimate.non_binding must be true`);
  assert.equal(instant.review_required, true, `${file} instant_estimate.review_required must be true`);
  assert.ok(typeof instant.disclaimer === "string" && instant.disclaimer.length > 0, `${file} instant_estimate.disclaimer must be non-empty`);

  const gates = doc.production?.gates;
  assert.ok(Array.isArray(gates), `${file} production.gates must be an array`);
  for (const gate of knownGates) {
    assert.ok(gates.includes(gate), `${file} production.gates missing: ${gate}`);
  }

  assert.equal(doc.agents?.approval_policy, "dry_run_then_human_approval", `${file} agents.approval_policy mismatch`);

  const brands = doc.brand?.brands;
  assert.ok(Array.isArray(brands) && brands.length > 0, `${file} brand.brands must be a non-empty array`);
  for (const b of brands) {
    assert.ok(typeof b.sender_domain === "string" && b.sender_domain.includes("."), `${file} brand ${b.key} needs a sender_domain`);
    assert.ok(typeof b.sender_mailbox === "string" && b.sender_mailbox.includes("@"), `${file} brand ${b.key} needs a sender_mailbox`);
  }

  walkStrings(doc, `${file}:$`, (path, value) => {
    for (const { name, re } of secretPatterns) {
      assert.ok(!re.test(value), `${file} value at ${path} looks like a secret (${name}): ${value.slice(0, 40)}...`);
    }
  });
}

// Tenant ids must be unique across all config files.
const ids = tenants.map((t) => t.doc.tenant.id);
assert.equal(new Set(ids).size, ids.length, `duplicate tenant ids across configs: ${ids.join(", ")}`);

// Isolation: a sender domain may belong to exactly one tenant.
const domainOwner = new Map();
for (const { file, doc } of tenants) {
  for (const b of doc.brand.brands) {
    const owner = domainOwner.get(b.sender_domain);
    assert.ok(!owner || owner === file, `sender domain ${b.sender_domain} appears in both ${owner} and ${file}`);
    domainOwner.set(b.sender_domain, file);
  }
}

function walkStrings(node, path, visit) {
  if (typeof node === "string") return visit(path, node);
  if (Array.isArray(node)) return node.forEach((v, i) => walkStrings(v, `${path}[${i}]`, visit));
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkStrings(v, `${path}.${k}`, visit);
  }
}

console.log(`ok ${tenants.length} tenant configs validated`);
