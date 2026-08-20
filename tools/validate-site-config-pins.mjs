#!/usr/bin/env node
// Every bounded capture rail in the Frappe app refuses to run until its issuer
// identity is pinned in the site config. A key that ships in the app but never
// reaches a provisioning path leaves that rail dead on every freshly provisioned
// site while CI stays green, because the app's own tests set the key themselves.
// That is exactly how the fleet capture rail shipped dead (IRO-54): the app read
// `ironwrap_fleet_capture_issuer_user`, no provisioner ever wrote it, and the
// device saw `fleet_issuer_not_configured` on the documented compose path.
//
// This validator closes the loop: every `ironwrap_*_user` site-config key the
// shipped app reads must be pinned by the local provisioner (or carry a written
// exemption saying which identity provisions it instead), and must be documented
// in the white-label playbook so no tenant site inherits a dead rail either.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const APP_SOURCE_DIR = join(root, "frappe-apps", "ironwrap_roofing", "ironwrap_roofing");
const PROVISIONER_FILES = [
  join(root, "deploy", "local", "frappe-init.sh"),
  join(root, "deploy", "local", "predev.mjs"),
];
const PLAYBOOK_FILE = join(root, "docs", "WHITE-LABEL-CLONE-PLAYBOOK.md");

// A site-config key the shipped app reads, as it appears in a Python string.
const IDENTITY_KEY_IN_SOURCE = /"(ironwrap_[a-z0-9_]*_user)"/g;
// `bench ... set-config <key> <value>` in shell, or a "set-config", "<key>" argv
// pair in the Node provisioner.
const PINNED_KEY = /set-config["',\s]+(ironwrap_[a-z0-9_]*_user)/g;

// Identities the local compose stack deliberately does not provision. Each entry
// must say who provisions it instead; an exemption without a reason is a silent
// dead rail wearing a different hat.
export const LOCAL_STACK_EXEMPTIONS = new Map([
  [
    "ironwrap_launch_proof_reader_user",
    "release-tool reader identity supplied by the operator who runs tools/launch-proof.mjs against a deployed site; never part of the local compose rail",
  ],
]);

export function validateSiteConfigPins({
  consumedKeys,
  pinnedKeys,
  playbookText,
  exemptions = LOCAL_STACK_EXEMPTIONS,
}) {
  const consumed = new Set(consumedKeys);
  const pinned = new Set(pinnedKeys);
  assert.ok(consumed.size > 0, "no ironwrap_*_user site-config keys found in the app source");

  for (const key of [...consumed].sort()) {
    const exemption = exemptions.get(key);
    assert.ok(
      pinned.has(key) || exemption,
      `site-config key ${key} is read by the shipped app but no provisioner pins it: the rail it guards is dead on every fresh site. Pin it in deploy/local/frappe-init.sh, or add a written exemption to tools/validate-site-config-pins.mjs.`,
    );
    assert.ok(
      playbookText.includes(key),
      `site-config key ${key} is read by the shipped app but docs/WHITE-LABEL-CLONE-PLAYBOOK.md never mentions it: every new tenant site would inherit a dead rail.`,
    );
  }

  for (const [key, reason] of exemptions) {
    assert.ok(
      consumed.has(key),
      `stale exemption: ${key} is exempted from local provisioning but no shipped code reads it`,
    );
    assert.ok(
      !pinned.has(key),
      `contradictory exemption: ${key} is exempted from local provisioning but a provisioner pins it anyway`,
    );
    assert.ok(
      typeof reason === "string" && reason.trim().length > 20,
      `exemption for ${key} must state which identity provisions it instead`,
    );
  }

  for (const key of [...pinned].sort()) {
    assert.ok(
      consumed.has(key),
      `provisioners pin ${key} but no shipped code reads it: remove the dead pin or restore its consumer`,
    );
  }

  return { consumed: [...consumed].sort(), pinned: [...pinned].sort() };
}

export function collectMatches(text, pattern) {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match[1]);
}

function pythonSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...pythonSources(full));
    } else if (entry.endsWith(".py")) {
      found.push(full);
    }
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const consumedKeys = pythonSources(APP_SOURCE_DIR).flatMap((file) =>
    collectMatches(readFileSync(file, "utf8"), IDENTITY_KEY_IN_SOURCE),
  );
  const pinnedKeys = PROVISIONER_FILES.flatMap((file) =>
    collectMatches(readFileSync(file, "utf8"), PINNED_KEY),
  );
  const playbookText = readFileSync(PLAYBOOK_FILE, "utf8");

  const { consumed, pinned } = validateSiteConfigPins({ consumedKeys, pinnedKeys, playbookText });
  console.log(
    `ok ${consumed.length} site-config identity keys validated (${pinned.length} pinned by ${PROVISIONER_FILES.map((f) => relative(root, f)).join(" + ")}, ${LOCAL_STACK_EXEMPTIONS.size} exempted)`,
  );
}
