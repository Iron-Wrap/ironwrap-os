import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { railAuthorizationHeader } from "../workers-bus/src/rail-frappe-credentials.ts";
import {
  assertEveryRailIssuerIsDeclared,
  IDENTITY_DOMAIN_DECLARATION,
  ISOLATED_RAILS,
  validateRailCredentialIsolation,
  verifyRailCredentialRouting,
  verifySharedWriterRouting,
} from "./validate-rail-credential-isolation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RAIL = {
  rail: "fleet_capture",
  keyBinding: "FLEET_CAPTURE_FRAPPE_API_KEY",
  secretBinding: "FLEET_CAPTURE_FRAPPE_API_SECRET",
  siteConfigKey: "ironwrap_fleet_capture_issuer_user",
  issuerUser: "ironwrap-fleet-capture@$IDENTITY_DOMAIN",
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
  authorizingExport: "frappeFieldAuthorization",
  railPaths: ["/api/method/ironwrap_roofing.work_package_api.capture_work_package_evidence"],
  sharedPaths: [
    "/api/method/ironwrap_roofing.field_evidence_api.record_verified_field_evidence",
    "/api/resource/Field%20Check-in",
  ],
};

const SHARED_WRITER_RAIL = {
  ...RAIL,
  rail: "work_package",
  keyBinding: "WORK_PACKAGE_FRAPPE_API_KEY",
  secretBinding: "WORK_PACKAGE_FRAPPE_API_SECRET",
  siteConfigKey: "ironwrap_work_package_issuer_user",
  issuerUser: "ironwrap-work-package@$IDENTITY_DOMAIN",
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
      IDENTITY_DOMAIN_DECLARATION,
      rail.issuerUser,
      rail.credentialFile,
      `set-config ${rail.siteConfigKey} "${rail.issuerUser}"`,
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
      IDENTITY_DOMAIN_DECLARATION,
      RAIL.issuerUser,
      RAIL.credentialFile,
      `set-config ${RAIL.siteConfigKey} "${RAIL.issuerUser}"`,
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
        files: healthyFiles({
          frappeInit: [
            IDENTITY_DOMAIN_DECLARATION,
            `set-config ${RAIL.siteConfigKey} "someone-else@example.invalid"`,
          ].join("\n"),
        }),
      }),
    /never creates ironwrap-fleet-capture@\$IDENTITY_DOMAIN/,
  );
});

test("a rail still pinned to the shared bus user is rejected", () => {
  assert.throws(
    () =>
      validateRailCredentialIsolation({
        rails: [RAIL],
        files: healthyFiles({
          frappeInit: [
            IDENTITY_DOMAIN_DECLARATION,
            RAIL.issuerUser,
            RAIL.credentialFile,
            `set-config ${RAIL.siteConfigKey} "ironwrap-bus@$IDENTITY_DOMAIN"`,
          ].join("\n"),
        }),
      }),
    /must pin ironwrap_fleet_capture_issuer_user to ironwrap-fleet-capture@\$IDENTITY_DOMAIN/,
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
    issuerUser: "ironwrap-work-package@$IDENTITY_DOMAIN",
    siteConfigKey: "ironwrap_work_package_issuer_user",
  };
  const files = healthyFiles({
    frappeInit: [
      IDENTITY_DOMAIN_DECLARATION,
      RAIL.issuerUser,
      twin.issuerUser,
      RAIL.credentialFile,
      `set-config ${RAIL.siteConfigKey} "${RAIL.issuerUser}"`,
      `set-config ${twin.siteConfigKey} "${twin.issuerUser}"`,
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

// ---------------------------------------------------------------------------------------------
// ELEC-143: the behavioural half. Every writer below is a REAL function, not a source string, and
// every one of them satisfies the textual checks above — the reviewer's `false &&` bypass reads
// correctly by construction. What separates them is what they return when called, which is the
// only thing a credential-isolation control can honestly assert.
// ---------------------------------------------------------------------------------------------

/** The shared-rail half of the shipped writer, reproduced exactly. */
function sharedFallback(env) {
  if (!env.ERPNEXT_API_KEY || !env.ERPNEXT_API_SECRET)
    throw new Error("frappe_field_not_configured");
  return `token ${env.ERPNEXT_API_KEY}:${env.ERPNEXT_API_SECRET}`;
}

/** The real rail resolver, so a fake writer fails for its own reason and not for a fake one. */
const railHeader = (env) => railAuthorizationHeader(env, "work_package");

const WRITERS = {
  healthy: (env, path) =>
    path.includes("work_package_api") ? railHeader(env) : sharedFallback(env),

  // The reviewer's exact bypass: an unreachable branch. Discriminator present, rail call present,
  // both textually ahead of the shared fallback.
  alwaysFalseGuard: (env, path) => {
    if (false && path.includes("work_package_api")) return railHeader(env);
    return sharedFallback(env);
  },

  negatedDiscriminator: (env, path) => {
    if (!path.includes("work_package_api")) return railHeader(env);
    return sharedFallback(env);
  },

  // Branch intact and first, but it hands the rail the shared pair.
  hoistedSharedFallback: (env, path) => {
    if (path.includes("work_package_api")) return sharedFallback(env);
    return railHeader(env);
  },

  earlyReturn: (env, path) => {
    return sharedFallback(env);
    // eslint-disable-next-line no-unreachable
    if (path.includes("work_package_api")) return railHeader(env);
  },

  deletedBranch: (env) => sharedFallback(env),

  // Passes the "rail answers on its own pair" probe and leaks the moment a rotation leaves the
  // binding unset for a minute: the shape a `??` fallback produces.
  degradesWhenUnset: (env, path) => {
    if (path.includes("work_package_api") && env.WORK_PACKAGE_FRAPPE_API_KEY) return railHeader(env);
    return sharedFallback(env);
  },

  // The opposite failure: the discriminator swallows the still-shared rail, which now issues as
  // an identity holding none of its grants.
  overBroadDiscriminator: (env, path) =>
    path.includes("api") ? railHeader(env) : sharedFallback(env),

  // Builds the rail header itself instead of going through the rail resolver, so the bus pair
  // pasted into the rail binding is accepted here even though `resolveRailFrappeCredential`
  // refuses it everywhere else.
  acceptsImpostorPair: (env, path) => {
    if (path.includes("work_package_api")) {
      if (!env.WORK_PACKAGE_FRAPPE_API_KEY || !env.WORK_PACKAGE_FRAPPE_API_SECRET)
        throw new Error("work_package_frappe_not_configured");
      return `token ${env.WORK_PACKAGE_FRAPPE_API_KEY}:${env.WORK_PACKAGE_FRAPPE_API_SECRET}`;
    }
    return sharedFallback(env);
  },
};

const loading = (writer) => async () => ({ frappeFieldAuthorization: writer });

function routeWriter(writer) {
  return verifySharedWriterRouting(SHARED_WRITER_RAIL, SHARED_WRITER, loading(writer));
}

test("the shipped writer routes each rail to its own identity when executed", async () => {
  // Guards every negative below: they must fail on their own defect, not on a broken harness.
  assert.equal(await routeWriter(WRITERS.healthy), 3);
});

test("an unreachable rail branch is rejected even though it reads correctly", async () => {
  // ELEC-143 finding 3, verbatim. This is the case the textual checks accept and CI shipped green.
  await assert.rejects(
    routeWriter(WRITERS.alwaysFalseGuard),
    /answered .*work_package_api.* with the shared bus pair instead of the work_package rail's own pair/,
  );
});

test("a negated discriminator is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.negatedDiscriminator),
    /answered .*work_package_api.* with the shared bus pair/,
  );
});

test("a rail branch that returns the shared pair is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.hoistedSharedFallback),
    /answered .*work_package_api.* with the shared bus pair/,
  );
});

test("an unconditional early return of the shared header is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.earlyReturn),
    /answered .*work_package_api.* with the shared bus pair/,
  );
});

test("a writer with no rail branch at all is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.deletedBranch),
    /answered .*work_package_api.* with the shared bus pair/,
  );
});

test("a rail that degrades to the shared pair when its binding is unset is rejected", async () => {
  // Not reachable by reading either: this one genuinely routes correctly while configured.
  await assert.rejects(
    routeWriter(WRITERS.degradesWhenUnset),
    /degrades to the shared identity instead of failing closed/,
  );
});

test("a discriminator that swallows the still-shared rail is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.overBroadDiscriminator),
    /instead of the shared bus pair: the discriminator now catches the field_evidence rail too/,
  );
});

test("a writer that accepts the bus pair inside the rail binding is rejected", async () => {
  await assert.rejects(
    routeWriter(WRITERS.acceptsImpostorPair),
    /bypasses resolveRailFrappeCredential\(\)'s shared-credential refusal/,
  );
});

test("a writer that stopped exporting its authorizer is rejected", async () => {
  // Un-exporting is the cheapest way to make the behavioural check unable to run; it must fail
  // loudly rather than degrade to the textual checks it was built to replace.
  await assert.rejects(
    verifySharedWriterRouting(SHARED_WRITER_RAIL, SHARED_WRITER, async () => ({})),
    /no longer exports frappeFieldAuthorization\(\)/,
  );
});

test("a shared writer declared without an executable contract is rejected", async () => {
  const { authorizingExport, railPaths, sharedPaths, ...textOnly } = SHARED_WRITER;
  await assert.rejects(
    verifySharedWriterRouting(SHARED_WRITER_RAIL, textOnly, loading(WRITERS.healthy)),
    /without an executable contract/,
  );
});

test("a rail set that declares no shared writer is accepted once the shared writer is retired", async () => {
  // Native cutover deleted workers-bus/src/frappe-field.ts. With no shared writer
  // left on disk, writers==0 is retirement, not a silent de-list.
  const result = await verifyRailCredentialRouting({
    rails: [RAIL],
    load: loading(WRITERS.healthy),
    sharedWriterPath: join(root, "workers-bus/src/frappe-field.ts"),
  });
  assert.deepEqual(result, { writers: 0, probes: 0 });
});

test("a rail set that de-lists a still-shipped shared writer is rejected", async () => {
  // De-listing the writer would otherwise delete the behavioural check with a one-line edit
  // while the shared writer keeps shipping. The floor only fires when the file still exists.
  const staging = mkdtempSync(join(tmpdir(), "ironwrap-shared-writer-"));
  const phantom = join(staging, "frappe-field.ts");
  writeFileSync(phantom, "// still shipping\n");
  try {
    await assert.rejects(
      verifyRailCredentialRouting({
        rails: [RAIL],
        load: loading(WRITERS.healthy),
        sharedWriterPath: phantom,
      }),
      /still exists but no shared writer is declared/,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
});

test("a Worker module that issues a rail without being declared a source is rejected", () => {
  // The de-listing hole from the other side: the checks only see the sources a rail claims.
  assert.throws(
    () =>
      assertEveryRailIssuerIsDeclared({
        rails: [SHARED_WRITER_RAIL],
        workerSources: {
          "workers-bus/src/frappe-field.ts": "declared",
          "workers-bus/src/some-new-writer.ts": 'railAuthorizationHeader(env, "work_package")',
        },
      }),
    /some-new-writer\.ts calls railAuthorizationHeader\(env, "work_package"\) but is not declared a work_package source/,
  );
});

test("the shipped Worker tree declares every module that reaches for a rail credential", () => {
  const sources = Object.fromEntries(
    readdirSync(join(root, "workers-bus/src"))
      .filter((entry) => entry.endsWith(".ts"))
      .map((entry) => [
        `workers-bus/src/${entry}`,
        readFileSync(join(root, "workers-bus/src", entry), "utf8"),
      ]),
  );
  assert.doesNotThrow(() =>
    assertEveryRailIssuerIsDeclared({ rails: ISOLATED_RAILS, workerSources: sources }),
  );
});
