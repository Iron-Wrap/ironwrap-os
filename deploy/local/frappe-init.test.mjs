import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createPublicKey } from "node:crypto";
import { tmpdir } from "node:os";
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


function shellFunction(name) {
  const match = script.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

test("local initialization provisions only active owner and Worker API identities", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "ironwrap-local-init-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const site = join(workspace, "sites", "synthetic");
  mkdirSync(site, { recursive: true });
  const identityName = script.match(/^(\w+)\(\) \{\n  local email=/m)?.[1];
  const groupName = script.match(/^(\w+)\(\) \{\n  provision_operator_users/m)?.[1];
  assert.ok(identityName && groupName);
  assert.match(script, new RegExp(`^${groupName}$`, "m"), "fresh initialization must use the checked group");
  assert.ok(shellFunction("reprovision_site").includes(groupName), "resync must use the same group");
  const run = (entrypoint = groupName) => execFileSync("bash", ["-c", `
set -euo pipefail
BENCH_DIR="$1"
SITE=synthetic
IDENTITY_DOMAIN=example.invalid
SCRATCH_DIR="$BENCH_DIR/scratch"
log() { :; }
bench() {
  local input
  input="$(cat)"
  printf '%s\n' "$input" >>"$BENCH_DIR/requests.log"
  printf '%s\n' 'CREDS:{"api_key":"synthetic-key","api_secret":"synthetic-secret"}'
}
${shellFunction("site_scratch")}
${shellFunction(identityName)}
${shellFunction("provision_operator_users")}
${shellFunction(groupName)}
${shellFunction("reprovision_site")}
provision_rail_issuer_identities() { :; }
pin_service_identities() { :; }
${entrypoint}
`, "bash", workspace], { encoding: "utf8" });
  run();
  const requests = readFileSync(join(workspace, "requests.log"), "utf8");
  const generated = [...requests.matchAll(/^email = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.deepEqual(generated, ["owner@example.invalid", "ironwrap-bus@example.invalid"]);
  assert.match(requests, /"crew@example.invalid", "Field Crew", "IronWrap Field"/);
  assert.match(requests, /"owner@example.invalid", "Owner Approver", "IronWrap Owner"/);
  assert.deepEqual(readdirSync(site).sort(), [".integration_credentials", ".owner_operator_credentials"]);
  const owner = readFileSync(join(site, ".owner_operator_credentials"));
  const worker = readFileSync(join(site, ".integration_credentials"));
  const retired = [".lead_triage_broker_credentials", ".quote_revision_broker_credentials",
    ".production_schedule_broker_credentials", ".proposal_publication_broker_credentials"];
  for (const file of retired) writeFileSync(join(site, file), "synthetic-existing-credential\n");
  writeFileSync(join(workspace, "requests.log"), "");
  run("reprovision_site synthetic");
  assert.doesNotMatch(readFileSync(join(workspace, "requests.log"), "utf8"), /generate_keys/);
  assert.deepEqual(readFileSync(join(site, ".owner_operator_credentials")), owner);
  assert.deepEqual(readFileSync(join(site, ".integration_credentials")), worker);
  for (const file of retired) {
    assert.equal(readFileSync(join(site, file), "utf8"), "synthetic-existing-credential\n");
  }
});

test("the supported preflight persists its verifier public key and preserves existing signing files", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "ironwrap-local-preflight-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const dir of ["deploy/local", "workers-bus", "app/dist", "bin"]) {
    mkdirSync(join(workspace, dir), { recursive: true });
  }
  for (const file of ["predev.mjs", "dev-vars.mjs"]) {
    cpSync(join(root, "deploy/local", file), join(workspace, "deploy/local", file));
  }
  cpSync(join(root, "workers-bus/.dev.vars.example"), join(workspace, "workers-bus/.dev.vars.example"));
  writeFileSync(join(workspace, "app/dist/manifest.webmanifest"), "{}");
  const executable = (name, source) => writeFileSync(join(workspace, "bin", name),
    "#!/bin/sh\nset -eu\n" + source, { mode: 0o755 });
  executable("docker", `
case "$*" in
  *' --profile frappe up -d') echo boot >>"$PROBE_CALLS";;
  *' test -f '*) exit 1;;
  *' cat '*)
    case "$*" in
      *'/.integration_credentials'|*'/.quickbooks_reconciliation_issuer_credentials'|*'/.customer_acceptance_credentials'|*'/.facet_design_projection_credentials'|*'/.fleet_capture_issuer_credentials'|*'/.work_package_issuer_credentials')
        printf '%s\n' "$*" >>"$PROBE_CALLS"
        printf '%s\n' '{"api_key":"synthetic-fixture","api_secret":"synthetic-fixture"}';;
      *) exit 93;;
    esac;;
  *' set-config -- '*) echo compatibility-config >>"$PROBE_CALLS";;
  *) exit 94;;
esac
`);
  executable("curl", 'printf \'{"message":"pong"}\'\n');
  executable("npx", `test "$*" = 'wrangler d1 migrations apply ironwrap-bus --local --env local'
echo local-migration-command >>"$PROBE_CALLS"
`);
  const calls = join(workspace, "calls.log");
  const run = () => execFileSync(process.execPath, [join(workspace, "deploy/local/predev.mjs")], {
    cwd: workspace,
    env: { PATH: `${join(workspace, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      PROBE_CALLS: calls, IRONWRAP_LOCAL_WORKER_PORT: "7121" },
    encoding: "utf8",
  });
  run();
  const keys = join(workspace, "deploy/local/keys");
  const publicPath = join(keys, "hermes-approval-public.pem");
  const publicKey = readFileSync(publicPath);
  assert.equal(createPublicKey(publicKey).asymmetricKeyType, "ed25519");
  assert.deepEqual(readdirSync(keys).sort(), [
    "customer-acceptance-hmac-key.txt", "effect-runtime-token.txt",
    "facet-design-projection-hmac-key.txt", "facet-launch-hmac-key.txt",
    "facet-v2-delivery-secret.txt", "hermes-approval-public.pem",
  ]);
  const requests = readFileSync(calls, "utf8");
  assert.match(requests, /local-migration-command/);
  for (const name of ["integration", "quickbooks_reconciliation_issuer", "customer_acceptance",
    "facet_design_projection", "fleet_capture_issuer", "work_package_issuer"]) {
    assert.ok(requests.includes(`/.${name}_credentials`), `missing active ${name} credentials`);
  }
  for (const file of ["hermes-approval-private.pem", "dry-run-signing-key.txt"]) {
    writeFileSync(join(keys, file), "synthetic-existing-input\n", { mode: 0o600 });
  }
  const vars = join(workspace, "workers-bus/.dev.vars");
  const priorVars = readFileSync(vars);
  run();
  assert.deepEqual(readFileSync(publicPath), publicKey);
  assert.deepEqual(readFileSync(vars), priorVars);
  for (const file of ["hermes-approval-private.pem", "dry-run-signing-key.txt"]) {
    assert.equal(readFileSync(join(keys, file), "utf8"), "synthetic-existing-input\n");
  }
});
