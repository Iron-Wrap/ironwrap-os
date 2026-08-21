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

// A rail whose issuing module also serves a still-shared rail, the way `frappe-field.ts` issues
// both `work_package_api` (isolated) and `field_evidence_api` (shared bus pair). The exclusive
// "must never name the shared pair" rule cannot apply here, so the contract is the routing order.
const SHARED_WRITER = {
  path: "workers-bus/src/frappe-field.ts",
  sharedWith: "field_evidence",
  authorizingFunction: "frappeFieldAuthorization",
  railDiscriminator: "work_package_api",
};

const SHARED_WRITER_RAIL = {
  ...RAIL,
  rail: "work_package",
  keyBinding: "WORK_PACKAGE_FRAPPE_API_KEY",
  secretBinding: "WORK_PACKAGE_FRAPPE_API_SECRET",
  siteConfigKey: "ironwrap_work_package_issuer_user",
  issuerUser: "ironwrap-work-package@ironwrap.local",
  role: "IronWrap Work Package Issuer",
  credentialFile: ".work_package_issuer_credentials",
  sources: [SHARED_WRITER],
};

/** The shipped shape: the rail branch resolves before the shared fallback is reachable. */
function sharedWriterSource(body) {
  return `function frappeFieldAuthorization(env: AppEnv, path: string): string {\n${body}\n}\n`;
}

const HEALTHY_WRITER_BODY = [
  '  if (path.includes("work_package_api"))',
  '    return railAuthorizationHeader(env, "work_package");',
  "  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)",
  '    throw new Error("frappe_field_not_configured");',
  "  return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;",
].join("\n");

function sharedWriterFiles(body = HEALTHY_WRITER_BODY) {
  const rail = SHARED_WRITER_RAIL;
  return {
    secretBindings: `${rail.keyBinding} ${rail.secretBinding}`,
    appTypes: `${rail.keyBinding} ${rail.secretBinding}`,
    railCredentials: `${rail.keyBinding} ${rail.secretBinding}`,
    devVarsExample: `${rail.keyBinding} ${rail.secretBinding}`,
    predev: `${rail.keyBinding} ${rail.secretBinding} ${rail.credentialFile}`,
    frappeInit: [
      rail.issuerUser,
      rail.credentialFile,
      `set-config ${rail.siteConfigKey} ${rail.issuerUser}`,
    ].join("\n"),
    accessControl: rail.role,
    playbook: rail.role,
    railSources: { [rail.rail]: { [SHARED_WRITER.path]: sharedWriterSource(body) } },
  };
}

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

test("a shared writer whose healthy routing is intact is accepted", () => {
  // Guards the negatives below: they must fail for their own reason, not because the fixture is
  // broken to begin with.
  assert.deepEqual(
    validateRailCredentialIsolation({ rails: [SHARED_WRITER_RAIL], files: sharedWriterFiles() }),
    { rails: ["work_package"] },
  );
});

test("a shared writer that loses the rail's routing branch is rejected", () => {
  // ELEC-140 review finding 1: the exact regression that shipped green while `frappe-field.ts`
  // was untracked. Deleting the branch leaves the work-package rail on the shared bus pair.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [SHARED_WRITER_RAIL],
        files: sharedWriterFiles(
          [
            "  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)",
            '    throw new Error("frappe_field_not_configured");',
            "  return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;",
          ].join("\n"),
        ),
      }),
    /no longer distinguishes work_package_api/,
  );
});

test("a shared writer that answers the rail with the shared pair is rejected", () => {
  // The discriminator survives, the credential does not: the split is over and nothing else in
  // the repo changed, which is precisely why a plain diff review misses it.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [SHARED_WRITER_RAIL],
        files: sharedWriterFiles(
          [
            '  if (path.includes("work_package_api"))',
            "    return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;",
            "  return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;",
          ].join("\n"),
        ),
      }),
    /never calls railAuthorizationHeader\(env, "work_package"\)/,
  );
});

test("a shared writer whose shared fallback shadows the rail branch is rejected", () => {
  // Both halves are present, but the fallback returns first, so no work-package call ever
  // reaches its own issuer. Presence checks pass; only statement order tells the truth.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [SHARED_WRITER_RAIL],
        files: sharedWriterFiles(
          [
            "  if (!path.startsWith(`/api/method/ironwrap_roofing.work_package_api`))",
            "    return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;",
            '  return railAuthorizationHeader(env, "work_package");',
          ].join("\n"),
        ),
      }),
    /reaches the shared bus pair before it routes work_package_api/,
  );
});

test("a shared writer that stopped sharing must be re-declared as an exclusive source", () => {
  // Not a leak — the opposite. The looser shared-writer rule is no longer the right contract, so
  // the entry must move to a plain path and pick up the stricter "never names the pair" check.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [SHARED_WRITER_RAIL],
        files: sharedWriterFiles(
          [
            '  if (path.includes("work_package_api"))',
            '    return railAuthorizationHeader(env, "work_package");',
            '  return railAuthorizationHeader(env, "field_evidence");',
          ].join("\n"),
        ),
      }),
    /no longer names the shared pair at all/,
  );
});

test("a shared writer whose authorizing function was renamed away is rejected", () => {
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [SHARED_WRITER_RAIL],
        files: {
          ...sharedWriterFiles(),
          railSources: {
            work_package: {
              [SHARED_WRITER.path]:
                'function frappeAuthorization(env: AppEnv, path: string): string {\n' +
                `${HEALTHY_WRITER_BODY}\n}\n`,
            },
          },
        },
      }),
    /no longer defines frappeFieldAuthorization\(\)/,
  );
});

test("a declared rail source whose text nobody read is rejected", () => {
  // The omission class itself, at the harness level: before this, a source could be listed and
  // never actually loaded, and the loop over whatever WAS loaded still reported success.
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({ railSources: { [RAIL.rail]: {} } }),
      }),
    /is declared a fleet_capture source but its text was never read/,
  );
});
