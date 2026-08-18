#!/usr/bin/env node
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const tenantDir = join(root, "config", "tenants");

const requiredAreas = [
  "tenant",
  "runtime",
  "brand",
  "geography",
  "locale",
  "services",
  "materials",
  "estimates",
  "proposal",
  "production",
  "communications",
  "integrations",
  "agents",
  "market_defense",
  "data_ownership",
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
  assert.equal(typeof doc.runtime.app_tenant_name, "string", `${file} runtime.app_tenant_name must be a string`);
  assert.ok(doc.runtime.app_tenant_name.trim().length > 0, `${file} runtime.app_tenant_name must be non-empty`);

  const compliance = doc.geography?.compliance;
  assert.ok(compliance, `${file} missing geography.compliance`);
  assert.equal(compliance.casl_consent_required, true, `${file} casl_consent_required must be true`);

  const qh = compliance.quiet_hours;
  assert.ok(qh, `${file} missing geography.compliance.quiet_hours`);
  assert.ok(Number.isInteger(qh.start_hour) && qh.start_hour >= 0 && qh.start_hour <= 23, `${file} quiet_hours.start_hour out of range`);
  assert.ok(Number.isInteger(qh.end_hour) && qh.end_hour >= 0 && qh.end_hour <= 23, `${file} quiet_hours.end_hour out of range`);
  assert.ok(qh.start_hour < qh.end_hour, `${file} quiet_hours start must be before end`);
  assert.equal(typeof qh.timezone, "string", `${file} quiet_hours.timezone must be a string`);

  const consent = compliance.consent_ledger;
  assert.ok(consent, `${file} missing geography.compliance.consent_ledger`);
  for (const name of [
    "basis_required",
    "source_timestamp_required",
    "scope_required",
    "expiry_or_relevant_event_required",
    "revocation_and_suppression_required",
  ]) {
    assert.equal(consent[name], true, `${file} consent_ledger.${name} must be true`);
  }

  const prepaid = compliance.prepaid_contracting;
  assert.ok(prepaid, `${file} missing geography.compliance.prepaid_contracting`);
  assert.equal(prepaid.licence_gate_required, true, `${file} prepaid licence gate must be enabled`);
  assert.match(prepaid.licence_id_env, /^[A-Z][A-Z0-9_]+$/, `${file} prepaid licence must be environment-name-only`);
  assert.equal(prepaid.contract_template_gate_required, true, `${file} prepaid contract template gate must be enabled`);
  assert.ok(Number.isInteger(prepaid.record_retention_years) && prepaid.record_retention_years >= 3, `${file} prepaid record retention must be at least three years`);

  const fall = compliance.fall_protection;
  assert.ok(fall, `${file} missing geography.compliance.fall_protection`);
  assert.equal(fall.site_plan_policy_required, true, `${file} fall-protection plan policy must be enabled`);
  assert.equal(fall.offline_plan_required, true, `${file} fall-protection plan must be available offline`);
  assert.equal(fall.worker_acknowledgement_required, true, `${file} fall-protection acknowledgement must be required`);
  assert.equal(compliance.privacy_law, "Alberta PIPA", `${file} must declare Alberta PIPA`);

  const locale = doc.locale;
  assert.match(locale.language_tag, /^[a-z]{2}-[A-Z]{2}$/, `${file} locale.language_tag must be a language-region tag`);
  assert.match(locale.currency, /^[A-Z]{3}$/, `${file} locale.currency must be ISO 4217 shaped`);
  assert.equal(locale.timezone, qh.timezone, `${file} locale and quiet-hours timezones must match`);
  const tax = locale.tax;
  assert.ok(tax, `${file} missing locale.tax`);
  assert.equal(tax.country_code, "CA", `${file} tax country must be Canada`);
  assert.equal(tax.province_code, doc.geography.province, `${file} tax province must match service geography`);
  for (const name of ["gst_rate_bps", "provincial_sales_tax_rate_bps"]) {
    assert.ok(Number.isInteger(tax[name]) && tax[name] >= 0 && tax[name] <= 10_000, `${file} locale.tax.${name} must be basis points`);
  }
  if (tax.province_code === "AB") {
    assert.equal(tax.gst_rate_bps, 500, `${file} Alberta GST must be represented as 500 bps`);
    assert.equal(tax.provincial_sales_tax_rate_bps, 0, `${file} Alberta has no provincial sales tax`);
  }
  assert.match(tax.source, /^https:\/\//, `${file} locale.tax.source must be an HTTPS authority`);

  const instant = doc.estimates?.instant_estimate;
  assert.ok(instant, `${file} missing estimates.instant_estimate`);
  assert.equal(instant.online_price, false, `${file} instant_estimate.online_price must be false`);
  assert.equal(instant.measurement_required, true, `${file} instant_estimate.measurement_required must be true`);
  assert.equal(instant.review_required, true, `${file} instant_estimate.review_required must be true`);
  assert.ok(typeof instant.disclaimer === "string" && instant.disclaimer.length > 0, `${file} instant_estimate.disclaimer must be non-empty`);

  const quickBooks = doc.integrations?.quickbooks;
  assert.ok(quickBooks, `${file} missing integrations.quickbooks`);
  assert.equal(quickBooks.role, "accounting_truth", `${file} QuickBooks must remain accounting truth`);
  assert.match(quickBooks.webhook_verifier_env, /^[A-Z][A-Z0-9_]+$/, `${file} QuickBooks verifier must be an environment variable name`);
  assert.match(quickBooks.expected_realm_id_env, /^[A-Z][A-Z0-9_]+$/, `${file} QuickBooks expected realm must be an environment variable name`);
  assert.match(quickBooks.reconciliation_issuer_user_env, /^[A-Z][A-Z0-9_]+$/, `${file} QuickBooks issuer must be an environment variable name`);
  assert.notEqual(quickBooks.webhook_verifier_env, quickBooks.expected_realm_id_env, `${file} QuickBooks verifier and expected realm bindings must be distinct`);
  assert.notEqual(quickBooks.reconciliation_issuer_user_env, quickBooks.webhook_verifier_env, `${file} QuickBooks issuer and verifier bindings must be distinct`);

  const gates = doc.production?.gates;
  assert.ok(Array.isArray(gates), `${file} production.gates must be an array`);
  for (const gate of knownGates) {
    assert.ok(gates.includes(gate), `${file} production.gates missing: ${gate}`);
  }

  const scale = doc.production?.proof_scale;
  assert.ok(scale, `${file} missing production.proof_scale`);
  assert.ok(Number.isInteger(scale.capture_items_per_job) && scale.capture_items_per_job >= 400, `${file} field proof scale must cover at least 400 items`);
  assert.ok(Number.isInteger(scale.viewer_items_per_job) && scale.viewer_items_per_job >= 1051, `${file} proof viewer scale must cover at least 1051 items`);
  assert.equal(scale.server_verification_required, true, `${file} proof uploads require server verification`);

  const packet = doc.production?.assigned_packet;
  assert.equal(packet?.offline_required, true, `${file} assigned job packet must be offline-capable`);
  const requiredPacketParts = ["scope", "measurements", "materials", "change_orders", "safety_plan", "proof_checklist"];
  assert.ok(Array.isArray(packet?.includes), `${file} assigned_packet.includes must be an array`);
  for (const part of requiredPacketParts) {
    assert.ok(packet.includes.includes(part), `${file} assigned packet missing ${part}`);
  }

  assert.equal(doc.agents?.approval_policy, "dry_run_then_human_approval", `${file} agents.approval_policy mismatch`);
  const writeGuards = doc.agents?.write_guard_envs;
  assert.ok(Array.isArray(writeGuards), `${file} agents.write_guard_envs must be an array`);
  for (const guard of [
    "ERPNEXT_WRITE_ENABLED",
    "HERMES_DRY_RUN_SIGNING_KEY",
    "HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "IRONWRAP_HERMES_APPROVAL_PUBLIC_KEY_FILE",
    "IRONWRAP_HERMES_SITE_BASE_URL",
  ]) {
    assert.ok(writeGuards.includes(guard), `${file} agents.write_guard_envs missing ${guard}`);
  }
  assert.ok(!writeGuards.includes("HERMES_WRITE_TOKEN"),
    `${file} Frappe write guards must not use the bus replay token`);

  const brands = doc.brand?.brands;
  assert.ok(Array.isArray(brands) && brands.length > 0, `${file} brand.brands must be a non-empty array`);
  for (const b of brands) {
    assert.ok(typeof b.sender_domain === "string" && b.sender_domain.includes("."), `${file} brand ${b.key} needs a sender_domain`);
    assert.ok(typeof b.sender_mailbox === "string" && b.sender_mailbox.includes("@"), `${file} brand ${b.key} needs a sender_mailbox`);
  }

  const ownership = doc.data_ownership;
  for (const name of [
    "canonical_job_identity_required",
    "full_export_required",
    "checksum_manifest_required",
    "restore_drill_required",
  ]) {
    assert.equal(ownership?.[name], true, `${file} data_ownership.${name} must be true`);
  }
  const requiredExportParts = ["raw_payloads", "business_records", "photos", "contracts", "communications", "audit_history"];
  assert.ok(Array.isArray(ownership?.export_includes), `${file} data_ownership.export_includes must be an array`);
  for (const part of requiredExportParts) {
    assert.ok(ownership.export_includes.includes(part), `${file} owned export missing ${part}`);
  }

  walkStrings(doc, `${file}:$`, (path, value) => {
    let publicReferenceUrl = null;
    if (value.startsWith("https://")) {
      try {
        publicReferenceUrl = new URL(value);
      } catch {
        assert.fail(`${file} value at ${path} starts like an HTTPS URL but is malformed`);
      }
      assert.equal(publicReferenceUrl.username, "", `${file} public URL at ${path} must not contain credentials`);
      assert.equal(publicReferenceUrl.password, "", `${file} public URL at ${path} must not contain credentials`);
      assert.equal(publicReferenceUrl.search, "", `${file} public URL at ${path} must not contain query credentials`);
      assert.equal(publicReferenceUrl.hash, "", `${file} public URL at ${path} must not contain fragments`);
    }
    for (const { name, re } of secretPatterns) {
      // A long public documentation path can resemble base64 when slash is part of
      // the detector. Credentials/query strings were rejected above; the path itself
      // is safe reference metadata.
      if (publicReferenceUrl && name === "long base64 blob") continue;
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
