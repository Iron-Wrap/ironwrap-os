#!/usr/bin/env node
// Per-rail Frappe credential isolation, checked as a contract rather than trusted as a habit.
//
// ELEC-48 audit section 3: the fleet-capture and work-package rails authenticated to Frappe with
// the single broad `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` pair — a System Manager — even though
// Frappe already scoped each rail to its own pinned issuer user. Splitting them is a five-file
// change, and every one of those files can silently regress on its own:
//
//   * a rail's fetch quietly goes back to `env.ERPNEXT_API_KEY` (isolation gone, tests still green)
//   * `frappe-init.sh` never creates the issuer user (rail dead on every fresh site — the ELEC-40
//     class the site-config-pin validator was built for, one level down: the PIN is present, the
//     IDENTITY behind it is not)
//   * `predev.mjs` never maps the credentials into the Worker env (rail dead on every local stack)
//   * `.dev.vars.example` / `secret-bindings.d.ts` never declare the binding (a fresh checkout is
//     missing the name entirely, and the Worker compile-time contract does not carry it)
//   * the white-label playbook never mentions it (every new tenant inherits a dead rail)
//
// This validator asserts all of that from the shipped sources, so the isolation cannot be
// half-undone by a later edit that looks locally reasonable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * One entry per isolated rail. `sources` are the Worker modules that issue the rail: none of them
 * may name the shared pair, because the whole point is that a leaked bus key cannot reach here.
 */
export const ISOLATED_RAILS = [
  {
    rail: "fleet_capture",
    keyBinding: "FLEET_CAPTURE_FRAPPE_API_KEY",
    secretBinding: "FLEET_CAPTURE_FRAPPE_API_SECRET",
    siteConfigKey: "ironwrap_fleet_capture_issuer_user",
    issuerUser: "ironwrap-fleet-capture@ironwrap.local",
    role: "IronWrap Fleet Capture Issuer",
    credentialFile: ".fleet_capture_issuer_credentials",
    sources: ["workers-bus/src/fleet-actions.ts", "workers-bus/src/fleet-panel.ts"],
  },
  {
    rail: "work_package",
    keyBinding: "WORK_PACKAGE_FRAPPE_API_KEY",
    secretBinding: "WORK_PACKAGE_FRAPPE_API_SECRET",
    siteConfigKey: "ironwrap_work_package_issuer_user",
    issuerUser: "ironwrap-work-package@ironwrap.local",
    role: "IronWrap Work Package Issuer",
    credentialFile: ".work_package_issuer_credentials",
    sources: ["workers-bus/src/work-package-actions.ts"],
  },
];

const SHARED_CREDENTIAL_BINDINGS = ["ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"];

export function validateRailCredentialIsolation({ rails, files }) {
  assert.ok(rails.length > 0, "no isolated rails declared");

  for (const rail of rails) {
    for (const binding of [rail.keyBinding, rail.secretBinding]) {
      assert.ok(
        files.secretBindings.includes(binding),
        `${binding} is not declared in workers-bus/src/secret-bindings.d.ts: the Worker's compile-time secret contract would not carry it on a clean build host.`,
      );
      assert.ok(
        files.appTypes.includes(binding),
        `${binding} is not declared on AppEnv in workers-bus/src/app-types.ts.`,
      );
      assert.ok(
        files.devVarsExample.includes(binding),
        `${binding} is missing from workers-bus/.dev.vars.example: a fresh checkout would not even know the name exists.`,
      );
      assert.ok(
        files.predev.includes(binding),
        `${binding} is never written by deploy/local/predev.mjs: the ${rail.rail} rail is dead on every local stack.`,
      );
      assert.ok(
        files.railCredentials.includes(binding),
        `${binding} is not bound to a rail in workers-bus/src/rail-frappe-credentials.ts.`,
      );
    }

    assert.ok(
      files.frappeInit.includes(rail.issuerUser),
      `deploy/local/frappe-init.sh never creates ${rail.issuerUser}: the ${rail.rail} rail's pin would name an identity that does not exist, which is a dead rail wearing a green pin.`,
    );
    assert.ok(
      files.frappeInit.includes(rail.credentialFile),
      `deploy/local/frappe-init.sh never writes ${rail.credentialFile}, so predev.mjs has nothing to read.`,
    );
    assert.ok(
      files.predev.includes(rail.credentialFile),
      `deploy/local/predev.mjs never reads ${rail.credentialFile}.`,
    );
    assert.ok(
      files.frappeInit.includes(`set-config ${rail.siteConfigKey} ${rail.issuerUser}`),
      `deploy/local/frappe-init.sh must pin ${rail.siteConfigKey} to ${rail.issuerUser}; pinning it to the shared bus user re-opens the blast radius this rail was split to close.`,
    );
    assert.ok(
      files.accessControl.includes(rail.role),
      `${rail.role} is not declared in access_control.py, so the issuer user would hold no grants at all.`,
    );
    assert.ok(
      files.playbook.includes(rail.role),
      `docs/WHITE-LABEL-CLONE-PLAYBOOK.md never mentions ${rail.role}: every new tenant site would issue this rail with the broad bus pair again.`,
    );

    for (const [path, text] of Object.entries(files.railSources[rail.rail])) {
      for (const shared of SHARED_CREDENTIAL_BINDINGS) {
        assert.ok(
          !text.includes(shared),
          `${path} references ${shared}: the ${rail.rail} rail must authenticate with ${rail.keyBinding}/${rail.secretBinding} only, otherwise a leaked bus key reaches it again.`,
        );
      }
    }
  }

  const bindings = rails.flatMap((rail) => [rail.keyBinding, rail.secretBinding]);
  assert.equal(
    new Set(bindings).size,
    bindings.length,
    "two rails share a credential binding: that is one identity wearing two names, not isolation",
  );
  const users = rails.map((rail) => rail.issuerUser);
  assert.equal(
    new Set(users).size,
    users.length,
    "two rails share an issuer user: a leak of either key still reaches both rails",
  );

  return { rails: rails.map((rail) => rail.rail) };
}

function read(relative) {
  return readFileSync(join(root, relative), "utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = {
    secretBindings: read("workers-bus/src/secret-bindings.d.ts"),
    appTypes: read("workers-bus/src/app-types.ts"),
    railCredentials: read("workers-bus/src/rail-frappe-credentials.ts"),
    devVarsExample: read("workers-bus/.dev.vars.example"),
    predev: read("deploy/local/predev.mjs"),
    frappeInit: read("deploy/local/frappe-init.sh"),
    accessControl: read("frappe-apps/ironwrap_roofing/ironwrap_roofing/access_control.py"),
    playbook: read("docs/WHITE-LABEL-CLONE-PLAYBOOK.md"),
    railSources: Object.fromEntries(
      ISOLATED_RAILS.map((rail) => [
        rail.rail,
        Object.fromEntries(rail.sources.map((path) => [path, read(path)])),
      ]),
    ),
  };

  const { rails } = validateRailCredentialIsolation({ rails: ISOLATED_RAILS, files });
  console.log(
    `ok ${rails.length} Frappe rails hold isolated credentials end to end (${rails.join(", ")})`,
  );
}
