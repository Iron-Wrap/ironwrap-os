import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { validateRailCredentialIsolation } from "./validate-rail-credential-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RAIL = {
  rail: "fleet_capture",
  keyBinding: "FLEET_CAPTURE_FRAPPE_API_KEY",
  secretBinding: "FLEET_CAPTURE_FRAPPE_API_SECRET",
  siteConfigKey: "ironwrap_fleet_capture_issuer_user",
  issuerUser: "ironwrap-fleet-capture@ironwrap.local",
  role: "IronWrap Fleet Capture Issuer",
  credentialFile: ".fleet_capture_issuer_credentials",
  sources: ["workers-bus/src/fleet-actions.ts"],
};

const BINDINGS = `${RAIL.keyBinding} ${RAIL.secretBinding}`;

function healthyFiles(overrides = {}) {
  return {
    secretBindings: BINDINGS,
    appTypes: BINDINGS,
    railCredentials: BINDINGS,
    devVarsExample: BINDINGS,
    predev: `${BINDINGS} ${RAIL.credentialFile}`,
    frappeInit: [
      RAIL.issuerUser,
      RAIL.credentialFile,
      `set-config ${RAIL.siteConfigKey} ${RAIL.issuerUser}`,
    ].join("\n"),
    accessControl: RAIL.role,
    playbook: RAIL.role,
    railSources: { [RAIL.rail]: { "workers-bus/src/fleet-actions.ts": "railAuthorizationHeader(env)" } },
    ...overrides,
  };
}

test("the checked-in sources isolate every declared rail end to end", () => {
  const script = new URL("./validate-rail-credential-isolation.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [script.pathname], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ok \d+ Frappe rails hold isolated credentials end to end/);
});

test("a rail whose module falls back to the shared bus pair is rejected", () => {
  // The ELEC-48 defect itself: the binding exists, the fetch still sends ERPNEXT_API_KEY.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({
          railSources: {
            [RAIL.rail]: {
              "workers-bus/src/fleet-actions.ts":
                "authorization: `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`",
            },
          },
        }),
      }),
    /references ERPNEXT_API_KEY/,
  );
});

test("a rail whose issuer user no provisioner creates is rejected", () => {
  // The pin would be green and the identity behind it absent: a dead rail on every fresh site.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({ frappeInit: `set-config ${RAIL.siteConfigKey} someone-else@example.invalid` }),
      }),
    /never creates ironwrap-fleet-capture@ironwrap\.local/,
  );
});

test("a rail still pinned to the shared bus user is rejected", () => {
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({
          frappeInit: [
            RAIL.issuerUser,
            RAIL.credentialFile,
            `set-config ${RAIL.siteConfigKey} ironwrap-bus@ironwrap.local`,
          ].join("\n"),
        }),
      }),
    /must pin ironwrap_fleet_capture_issuer_user to ironwrap-fleet-capture@ironwrap\.local/,
  );
});

test("a binding the local provisioner never writes is rejected", () => {
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({ predev: RAIL.credentialFile }),
      }),
    /never written by deploy\/local\/predev\.mjs/,
  );
});

test("a binding missing from the Worker secret contract is rejected", () => {
  assert.throws(
    () => validateRailCredentialIsolation({ rails: [RAIL], files: healthyFiles({ secretBindings: "" }) }),
    /not declared in workers-bus\/src\/secret-bindings\.d\.ts/,
  );
});

test("an undocumented rail role is rejected", () => {
  assert.throws(
    () => validateRailCredentialIsolation({ rails: [RAIL], files: healthyFiles({ playbook: "" }) }),
    /docs\/WHITE-LABEL-CLONE-PLAYBOOK\.md never mentions IronWrap Fleet Capture Issuer/,
  );
});

test("two rails sharing one credential binding are rejected", () => {
  // Everything else about the twin is healthy; only the credential binding is shared.
  const twin = {
    ...RAIL,
    rail: "work_package",
    issuerUser: "ironwrap-work-package@ironwrap.local",
    siteConfigKey: "ironwrap_work_package_issuer_user",
  };
  const files = healthyFiles({
    frappeInit: [
      RAIL.issuerUser,
      twin.issuerUser,
      RAIL.credentialFile,
      `set-config ${RAIL.siteConfigKey} ${RAIL.issuerUser}`,
      `set-config ${twin.siteConfigKey} ${twin.issuerUser}`,
    ].join("\n"),
    railSources: {
      [RAIL.rail]: { "workers-bus/src/fleet-actions.ts": "ok" },
      [twin.rail]: { "workers-bus/src/fleet-actions.ts": "ok" },
    },
  });
  assert.throws(
    () => validateRailCredentialIsolation({ rails: [RAIL, twin], files }),
    /two rails share a credential binding/,
  );
});
