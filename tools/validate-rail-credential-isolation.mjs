#!/usr/bin/env node
// Per-rail Frappe credential isolation, checked as a contract rather than trusted as a habit.
//
// ELEC-48 audit section 3: the fleet-capture and work-package rails authenticated to Frappe with
// the single broad `ERPNEXT_API_KEY`/`ERPNEXT_API_SECRET` pair — a System Manager — even though
// Frappe already scoped each rail to its own pinned issuer user. Splitting them is a five-file
// change, and every one of those files can silently regress on its own:
//
//   * a rail's fetch quietly goes back to `env.ERPNEXT_API_KEY` (isolation gone, tests still green)
//   * a writer that serves TWO rails loses the branch that routes this one to its own issuer, so
//     the rail falls through to the other rail's shared pair (ELEC-140 review finding 1: the
//     `frappe-field.ts` work-package branch was never tracked, so breaking it shipped green)
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
 * One entry per isolated rail. `sources` are the Worker modules that issue the rail, in one of
 * two shapes:
 *
 *   * a plain path — an EXCLUSIVE issuer. It may not name the shared pair at all, because the
 *     whole point is that a leaked bus key cannot reach here.
 *   * `{ path, sharedWith, authorizingFunction, railDiscriminator }` — a SHARED writer: one
 *     module that issues this rail and some other, still-shared rail, so the shared pair is
 *     legitimately present in the file and "must not mention it" would be the wrong contract.
 *     What must hold instead is that the rail is routed to its own issuer BEFORE the shared
 *     fallback is reachable. ELEC-140 found this class open: `frappe-field.ts` issues the
 *     work-package rail and was not tracked at all, so deleting its routing branch shipped green.
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
    sources: [
      "workers-bus/src/work-package-actions.ts",
      {
        // The field writer serves two rails: `work_package_api` (isolated, this rail) and
        // `field_evidence_api` / the Field Check-in resource (still the shared bus pair). One
        // fetch, two identities, chosen by method path — so the contract is the routing itself.
        path: "workers-bus/src/frappe-field.ts",
        sharedWith: "field_evidence",
        authorizingFunction: "frappeFieldAuthorization",
        railDiscriminator: "work_package_api",
      },
    ],
  },
];

const SHARED_CREDENTIAL_BINDINGS = ["ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"];

/** Both source shapes read the same way from here on. */
function normalizeSource(source) {
  return typeof source === "string" ? { path: source, sharedWith: null } : source;
}

function railSourcePaths(rail) {
  return rail.sources.map((source) => normalizeSource(source).path);
}

/**
 * The body of one top-level function, whitespace-collapsed so the assertions below survive
 * reformatting but still see statement order. Sliced to the next `}` in column 0, which is where
 * a top-level function closes in this repo's formatting; a mis-slice cannot pass silently,
 * because the shared-fallback assertion requires the slice to still contain the shared pair.
 */
function authorizingFunctionBody(text, name) {
  const start = text.indexOf(`function ${name}(`);
  if (start === -1) return null;
  const end = text.indexOf("\n}", start);
  return text.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}

/**
 * A module that issues an isolated rail alongside a still-shared one. Presence of the shared pair
 * is expected here; what may never regress is that the rail's own branch resolves first.
 */
function assertSharedWriterRoutesRail(rail, source, text) {
  const { path, authorizingFunction, railDiscriminator } = source;
  const railCall = `railAuthorizationHeader(env, "${rail.rail}")`;

  const body = authorizingFunctionBody(text, authorizingFunction);
  assert.ok(
    body !== null,
    `${path} no longer defines ${authorizingFunction}(): the ${rail.rail} rail's credential routing was tracked in that function, so this rename or removal must be re-pointed here rather than left unchecked.`,
  );
  assert.ok(
    body.includes(railDiscriminator),
    `${authorizingFunction}() in ${path} no longer distinguishes ${railDiscriminator}: without that discriminator every call in this writer authenticates as one identity, and the ${rail.rail} split is over.`,
  );
  assert.ok(
    body.includes(railCall),
    `${authorizingFunction}() in ${path} never calls ${railCall}: this writer issues ${railDiscriminator} on whatever credential it falls through to, which is exactly the ELEC-48 defect wearing a green validator.`,
  );

  const sharedAt = SHARED_CREDENTIAL_BINDINGS.map((binding) => body.indexOf(binding)).filter(
    (index) => index !== -1,
  );
  assert.ok(
    sharedAt.length > 0,
    `${authorizingFunction}() in ${path} no longer names the shared pair at all: it is now an exclusive ${rail.rail} issuer, so declare it as a plain path in that rail's \`sources\` and get the stricter check.`,
  );
  assert.ok(
    body.indexOf(railCall) < Math.min(...sharedAt),
    `${authorizingFunction}() in ${path} reaches the shared bus pair before it routes ${railDiscriminator} to ${railCall}: the fallback shadows the rail, so ${rail.rail} calls go out as a System Manager again.`,
  );
}

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

    // Driven by the rail's declared `sources`, not by whatever the caller happened to read: a
    // source the rail claims but nobody supplied must fail rather than be silently skipped.
    for (const source of rail.sources.map(normalizeSource)) {
      const text = files.railSources[rail.rail]?.[source.path];
      assert.ok(
        typeof text === "string",
        `${source.path} is declared a ${rail.rail} source but its text was never read, so none of its isolation is actually checked.`,
      );

      if (source.sharedWith) {
        assertSharedWriterRoutesRail(rail, source, text);
        continue;
      }

      for (const shared of SHARED_CREDENTIAL_BINDINGS) {
        assert.ok(
          !text.includes(shared),
          `${source.path} references ${shared}: the ${rail.rail} rail must authenticate with ${rail.keyBinding}/${rail.secretBinding} only, otherwise a leaked bus key reaches it again.`,
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
        Object.fromEntries(railSourcePaths(rail).map((path) => [path, read(path)])),
      ]),
    ),
  };

  const { rails } = validateRailCredentialIsolation({ rails: ISOLATED_RAILS, files });
  console.log(
    `ok ${rails.length} Frappe rails hold isolated credentials end to end (${rails.join(", ")})`,
  );
}
