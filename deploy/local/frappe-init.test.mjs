import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = readFileSync(join(root, "deploy/local/frappe-init.sh"), "utf8");
const predev = readFileSync(join(root, "deploy/local/predev.mjs"), "utf8");
const cloneTenant = readFileSync(join(root, "deploy/clone-tenant.sh"), "utf8");

// ELEC-143 finding 3. The credential helpers dump `bench console` output - a freshly minted
// api_secret in plain text - to a scratch file, then grep the secret out of it. That path used
// to be `/tmp/<credential-file>_raw.json`, derived from the credential file alone, so two sites
// provisioned through one container wrote and read the SAME file. Nothing caught it because the
// only caller (clone-tenant.sh) happens to run frappe-init as a fresh one-shot container per
// site: a property of the invocation model, not of this script.

test("the scratch directory is namespaced by site, not shared across a bench", () => {
  const line = script.match(/^SCRATCH_DIR=.*$/m)?.[0];
  assert.ok(line, "frappe-init.sh must define SCRATCH_DIR");
  assert.match(line, /\$SITE/, "a scratch path without $SITE is shared by every site on the bench");
});

test("two sites resolve to two different scratch directories", () => {
  const line = script.match(/^SCRATCH_DIR=.*$/m)[0];
  const resolveFor = (site) =>
    execFileSync("bash", ["-c", `set -u; SITE="$1"; ${line}; printf '%s' "$SCRATCH_DIR"`, "bash", site], {
      encoding: "utf8",
    });
  const a = resolveFor("ironwrap.localhost");
  const b = resolveFor("northline-metal.localhost");
  assert.notEqual(a, b, "one site's credential dump must not land on another site's path");
  assert.ok(a.endsWith("/ironwrap.localhost"));
  assert.ok(b.endsWith("/northline-metal.localhost"));
});

test("every credential dump is written to, and read back from, that per-site scratch", () => {
  const redirects = [...script.matchAll(/bench --site "\$SITE" console\s*>\s*(\S+)/g)].map((match) => match[1]);
  assert.ok(redirects.length >= 2, "the two credential helpers must still be found");
  for (const target of redirects) {
    assert.ok(
      target === '"$raw"' || target === "/dev/null",
      `a bench console dump goes to ${target}, which is neither the per-site scratch nor discarded`,
    );
  }
  const reads = [...script.matchAll(/grep -o 'CREDS:\{\.\*\}' (\S+)/g)].map((match) => match[1]);
  assert.equal(reads.length, 2);
  for (const source of reads) assert.equal(source, '"$raw"');
});

test("no scratch path is a hard-coded /tmp name", () => {
  const offenders = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => /(^|[^{:-])\/tmp\//.test(line));
  assert.deepEqual(offenders, [], "only the ${TMPDIR:-/tmp} default may name /tmp");
});

test("the plaintext secret dump is removed once the secret is safely in the site directory", () => {
  const removals = [...script.matchAll(/^\s*rm -f "\$raw"$/gm)];
  assert.equal(removals.length, 2, "each credential helper must clean up its own dump");
});

test("frappe-init no longer provisions or pins a customer-decision service issuer", () => {
  assert.doesNotMatch(
    script,
    /ironwrap_customer_decision_service_user|\.customer_decision_credentials|IronWrap Customer Decision Service/,
    "customer portal decisions are D1/Worker-authoritative and must not provision a Frappe decision issuer",
  );
});

test("local predev does not read or inject retired customer-decision Frappe credentials", () => {
  assert.doesNotMatch(
    predev,
    /\.customer_decision_credentials|APP_CUSTOMER_DECISION_FRAPPE_API_KEY|APP_CUSTOMER_DECISION_FRAPPE_API_SECRET|ironwrap_customer_decision_hmac_key/,
    "predev.mjs must not revive the retired customer-decision Frappe credential/config path",
  );
});

test("clone-tenant does not copy retired customer-decision Frappe credentials or site config", () => {
  assert.doesNotMatch(
    cloneTenant,
    /\.customer_decision_credentials|APP_CUSTOMER_DECISION_FRAPPE_API_KEY|APP_CUSTOMER_DECISION_FRAPPE_API_SECRET|ironwrap_customer_decision_hmac_key/,
    "clone-tenant.sh must not recreate the retired customer-decision Frappe authority",
  );
});
