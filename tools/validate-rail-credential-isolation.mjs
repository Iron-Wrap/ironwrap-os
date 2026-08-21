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
//   * that same writer KEEPS the branch and stops running it — `if (false && ...)`, a negated
//     condition, a hoisted fallback, an early return. The routing reads correctly and leaks every
//     call (ELEC-143). Text cannot tell a live branch from a dead one, so the shared-writer
//     contract is executed here rather than read: `verifyRailCredentialRouting` imports the
//     shipped module and asserts which identity each rail's real paths come back on.
//   * the writer is quietly de-listed from a rail's `sources`, which would delete both checks in
//     one line — so every Worker module that reaches for a rail credential must be declared
//   * `frappe-init.sh` never creates the issuer user (rail dead on every fresh site — the ELEC-40
//     class the site-config-pin validator was built for, one level down: the PIN is present, the
//     IDENTITY behind it is not)
//   * `predev.mjs` never maps the credentials into the Worker env (rail dead on every local stack)
//   * `.dev.vars.example` / `secret-bindings.d.ts` never declare the binding (a fresh checkout is
//     missing the name entirely, and the Worker compile-time contract does not carry it)
//   * the white-label playbook never mentions it (every new tenant inherits a dead rail)
//
// This validator asserts all of that from the shipped sources — read as text where the property
// is textual, and EXECUTED where the property is behavioural — so the isolation cannot be
// half-undone by a later edit that looks locally reasonable.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    issuerUser: "ironwrap-fleet-capture@$IDENTITY_DOMAIN",
    role: "IronWrap Fleet Capture Issuer",
    credentialFile: ".fleet_capture_issuer_credentials",
    sources: ["workers-bus/src/fleet-actions.ts", "workers-bus/src/fleet-panel.ts"],
  },
  {
    rail: "work_package",
    keyBinding: "WORK_PACKAGE_FRAPPE_API_KEY",
    secretBinding: "WORK_PACKAGE_FRAPPE_API_SECRET",
    siteConfigKey: "ironwrap_work_package_issuer_user",
    issuerUser: "ironwrap-work-package@$IDENTITY_DOMAIN",
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
        // The behavioural half of the same contract: the module's exported authorizer is CALLED
        // with these real paths and the identity it hands back is compared against the rail it
        // belongs to. `railPaths` must come back on this rail's own pair, `sharedPaths` on the
        // bus pair — both are load-bearing, because a writer that answers everything with the
        // rail identity has killed the field-evidence rail just as surely as the reverse leaks
        // the work-package one.
        authorizingExport: "frappeFieldAuthorization",
        railPaths: [
          "/api/method/ironwrap_roofing.work_package_api.capture_work_package_evidence",
        ],
        sharedPaths: [
          "/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence",
          "/api/resource/Field%20Check-in",
        ],
      },
    ],
  },
];

const SHARED_CREDENTIAL_BINDINGS = ["ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"];

// A cloned tenant provisions its identities on its OWN local domain, so the provisioner names
// them through `$IDENTITY_DOMAIN` rather than as literals - that variable is what stops a
// tenant's ERPNEXT_INTEGRATION_USER naming the first tenant's bus user. Its default is still
// pinned here so "parameterised" cannot quietly become "unset on the documented stack".
export const IDENTITY_DOMAIN_DECLARATION = 'IDENTITY_DOMAIN="${IRONWRAP_LOCAL_IDENTITY_DOMAIN:-ironwrap.local}"';

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

/**
 * Throwaway probe identities. These are not credentials and never leave this process: they are
 * distinguishable strings fed to a pure routing function so the header it returns names, by
 * itself, which rail answered. `token <a>:<b>` is the shape `frappe-field.ts` builds, so an
 * exact-match assertion on the whole header catches a rail that answers with the wrong pair AND
 * a rail that answers with half of one.
 */
const PROBE_SHARED_CREDENTIAL = { key: "probe-bus-key", secret: "probe-bus-secret" };

function probeRailCredential(rail) {
  return { key: `probe-${rail.rail}-key`, secret: `probe-${rail.rail}-secret` };
}

function probeHeader(credential) {
  return `token ${credential.key}:${credential.secret}`;
}

/** A Worker env holding only the credentials this probe means to offer, and nothing else. */
function probeEnv(rail, { railCredential, sharedCredential }) {
  const env = {};
  if (sharedCredential) {
    const [keyBinding, secretBinding] = SHARED_CREDENTIAL_BINDINGS;
    env[keyBinding] = sharedCredential.key;
    env[secretBinding] = sharedCredential.secret;
  }
  if (railCredential) {
    env[rail.keyBinding] = railCredential.key;
    env[rail.secretBinding] = railCredential.secret;
  }
  return env;
}

/**
 * What the writer actually did, as data rather than as control flow, so every assertion below can
 * report the identity that came back instead of "missing expected exception".
 */
function resolveProbe(authorize, env, path) {
  try {
    return { returned: true, header: authorize(env, path) };
  } catch (error) {
    return { returned: false, code: error instanceof Error ? error.message : String(error) };
  }
}

/** Names the probe identity a header carries, for failure messages that point at the culprit. */
function describeHeader(header, named) {
  for (const [label, credential] of named) {
    if (header === probeHeader(credential)) return `the ${label} pair`;
  }
  return `an unrecognised identity (${header})`;
}

/**
 * The behavioural contract for a shared writer, enforced by EXECUTING it.
 *
 * ELEC-143: the textual checks in `assertSharedWriterRoutesRail` verify that the routing branch
 * is written, not that it runs. `if (false && path.includes("work_package_api")) return
 * railAuthorizationHeader(env, "work_package")` satisfies every one of them — discriminator
 * present, rail call present, both textually ahead of the shared fallback — while every
 * work-package call falls through to the shared System Manager pair. So does a negated
 * condition, a shared fallback hoisted above a still-present branch, an unconditional early
 * return, and a `?? sharedHeader(env)` degradation. None of those move the checked strings
 * relative to each other, and none of them survive being called: this function calls the
 * shipped authorizer with real paths and asserts the identity it hands back.
 */
export async function verifySharedWriterRouting(rail, source, load) {
  const { path, authorizingExport, railPaths, sharedPaths } = source;
  assert.ok(
    authorizingExport && Array.isArray(railPaths) && railPaths.length > 0 && Array.isArray(sharedPaths) && sharedPaths.length > 0,
    `${path} is declared a shared writer for ${rail.rail} without an executable contract: \`authorizingExport\`, \`railPaths\` and \`sharedPaths\` are what make this check behavioural rather than a re-read of the source text.`,
  );

  const module = await load(path);
  const authorize = module?.[authorizingExport];
  assert.equal(
    typeof authorize,
    "function",
    `${path} no longer exports ${authorizingExport}(): it is exported so this validator can CALL it, because reading the ${rail.rail} routing as text cannot tell a live branch from a dead one. Re-export it or re-point this declaration; do not drop the behavioural check.`,
  );

  const railCredential = probeRailCredential(rail);
  const named = [
    ["shared bus", PROBE_SHARED_CREDENTIAL],
    [`${rail.rail} rail`, railCredential],
  ];
  const configured = probeEnv(rail, { railCredential, sharedCredential: PROBE_SHARED_CREDENTIAL });

  // 1. The rail's own paths come back on the rail's own identity. This is the assertion the
  //    ELEC-143 bypass fails: an unreachable branch answers here with the shared pair.
  for (const railPath of railPaths) {
    const probe = resolveProbe(authorize, configured, railPath);
    assert.ok(
      probe.returned,
      `${authorizingExport}() refused ${railPath} with ${probe.code} while both pairs were configured: the ${rail.rail} rail cannot issue at all, which is a dead rail rather than an isolated one.`,
    );
    assert.equal(
      probe.header,
      probeHeader(railCredential),
      `${authorizingExport}() in ${path} answered ${railPath} with ${describeHeader(probe.header, named)} instead of the ${rail.rail} rail's own pair. The routing branch is written but does not RUN — an always-false guard, a negated condition, a hoisted fallback or an early return all read correctly and leak exactly this way (ELEC-143).`,
    );
  }

  // 2. The still-shared rail is still served. A writer that answers everything with the isolated
  //    identity has not over-secured anything: it has taken the other rail's grants away from it.
  for (const sharedPath of sharedPaths) {
    const probe = resolveProbe(authorize, configured, sharedPath);
    assert.ok(
      probe.returned,
      `${authorizingExport}() refused ${sharedPath} with ${probe.code}: the ${source.sharedWith} rail legitimately rides the shared bus pair here and must keep issuing.`,
    );
    assert.equal(
      probe.header,
      probeHeader(PROBE_SHARED_CREDENTIAL),
      `${authorizingExport}() in ${path} answered ${sharedPath} with ${describeHeader(probe.header, named)} instead of the shared bus pair: the discriminator now catches the ${source.sharedWith} rail too, so that rail issues as an identity holding none of its grants.`,
    );
  }

  // 3. Fail closed. With the rail's pair absent, its paths must REFUSE rather than degrade to the
  //    shared pair — the `railHeader(env) ?? sharedHeader(env)` shape passes step 1 and leaks the
  //    moment a rotation leaves the binding briefly unset.
  const withoutRailPair = probeEnv(rail, { railCredential: null, sharedCredential: PROBE_SHARED_CREDENTIAL });
  for (const railPath of railPaths) {
    const probe = resolveProbe(authorize, withoutRailPair, railPath);
    assert.equal(
      probe.returned,
      false,
      `${authorizingExport}() in ${path} answered ${railPath} with ${probe.returned ? describeHeader(probe.header, named) : ""} while ${rail.keyBinding}/${rail.secretBinding} were unset: the rail degrades to the shared identity instead of failing closed, so an unset binding is a silent privilege escalation rather than a visible outage.`,
    );
  }

  // 4. Value-level isolation reaches this writer too: the rail binding holding the bus pair's
  //    VALUES is the ELEC-48 defect wearing a rail's binding name, and must be refused here.
  const impostorPair = probeEnv(rail, {
    railCredential: PROBE_SHARED_CREDENTIAL,
    sharedCredential: PROBE_SHARED_CREDENTIAL,
  });
  for (const railPath of railPaths) {
    const probe = resolveProbe(authorize, impostorPair, railPath);
    assert.equal(
      probe.returned,
      false,
      `${authorizingExport}() in ${path} issued ${railPath} while ${rail.keyBinding} held the shared bus value: this writer bypasses resolveRailFrappeCredential()'s shared-credential refusal, so the split is a binding name and nothing else.`,
    );
  }

  return railPaths.length + sharedPaths.length;
}

/**
 * Executes every declared shared writer. Separate from the textual pass because the two answer
 * different questions — "is the routing written and ordered" versus "is it what actually runs" —
 * and a control that only ever answered the first is what ELEC-143 found.
 */
export async function verifyRailCredentialRouting({ rails, load }) {
  let probes = 0;
  let writers = 0;
  for (const rail of rails) {
    for (const source of rail.sources.map(normalizeSource)) {
      if (!source.sharedWith) continue;
      writers += 1;
      probes += await verifySharedWriterRouting(rail, source, load);
    }
  }
  assert.ok(
    writers > 0,
    "no shared writer is declared on any rail, so nothing executed: the behavioural half of this control only runs against sources it is pointed at, and de-listing the writer is the cheapest way to make it disappear.",
  );
  return { writers, probes };
}

/**
 * Completeness floor for the declarations above. Both checks — textual and behavioural — only
 * ever look at the sources a rail CLAIMS, so removing `frappe-field.ts` from `sources` deletes
 * the entire check with a one-line edit and leaves CI green. Any Worker module that reaches for
 * a rail's credential must therefore be declared a source of that rail.
 *
 * A floor, not a proof: a call built through a variable rail name is not matched. It closes the
 * de-listing hole and the "a new module started issuing this rail untracked" hole, which is the
 * class ELEC-140 finding 1 actually was.
 */
export function assertEveryRailIssuerIsDeclared({ rails, workerSources }) {
  assert.ok(
    workerSources && Object.keys(workerSources).length > 0,
    "no Worker sources were swept for undeclared rail issuers, so a module that quietly started issuing a rail would never be seen.",
  );
  for (const rail of rails) {
    const declared = new Set(railSourcePaths(rail));
    const reaches = [
      `railAuthorizationHeader(env, "${rail.rail}")`,
      `requireRailFrappeCredential(env, "${rail.rail}")`,
    ];
    for (const [path, text] of Object.entries(workerSources)) {
      if (declared.has(path)) continue;
      for (const call of reaches) {
        assert.ok(
          !text.includes(call),
          `${path} calls ${call} but is not declared a ${rail.rail} source: an issuer nobody declared is an issuer nobody checks, and de-listing a declared one is how this control gets deleted in a single line.`,
        );
      }
    }
  }
}

export function validateRailCredentialIsolation({ rails, files }) {
  assert.ok(rails.length > 0, "no isolated rails declared");
  assert.ok(
    files.frappeInit.includes(IDENTITY_DOMAIN_DECLARATION),
    `deploy/local/frappe-init.sh must declare ${IDENTITY_DOMAIN_DECLARATION}: the rail issuer identities are named through it, and without the default the documented single stack would provision them on an empty domain.`,
  );

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
      files.frappeInit.includes(`set-config ${rail.siteConfigKey} "${rail.issuerUser}"`),
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

/** Every Worker module, for the undeclared-issuer sweep. */
function readWorkerSources() {
  const directory = "workers-bus/src";
  return Object.fromEntries(
    readdirSync(join(root, directory))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => [`${directory}/${entry}`, read(`${directory}/${entry}`)]),
  );
}

/**
 * Loads a declared source AS A MODULE. Node strips the types, so the validator executes the same
 * bytes the Worker bundles rather than a re-implementation of them; the Worker suite already runs
 * this way (`npm test --prefix workers-bus` over `.ts` tests importing `.ts` sources).
 */
function importRailSource(relative) {
  return import(pathToFileURL(join(root, relative)).href);
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
  assertEveryRailIssuerIsDeclared({ rails: ISOLATED_RAILS, workerSources: readWorkerSources() });
  const { writers, probes } = await verifyRailCredentialRouting({
    rails: ISOLATED_RAILS,
    load: importRailSource,
  });
  console.log(
    `ok ${rails.length} Frappe rails hold isolated credentials end to end (${rails.join(", ")}); ` +
      `${probes} routing probes executed against ${writers} shared writer${writers === 1 ? "" : "s"}`,
  );
}
