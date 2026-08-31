import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import type { AppEnv, AppRole } from "../src/app-types.ts";
import {
  CAPABILITY_SIGNAL_IDS,
  CAPABILITY_SIGNAL_REGISTRY,
  NAMED_REFERENCE_CAPABILITY_IDS,
  evaluateCapabilitySignals,
  type CapabilitySignalId,
  type CapabilitySignalItem,
} from "../src/capability-signal.ts";
import {
  buildCapabilitySignalReadModel,
  type OfficeCapabilityItem,
  type ScopedCapabilityItem,
} from "../src/capability-signal-api.ts";
import { handleFacetDesignIngest } from "../src/facet-design-ingest.ts";
import { handleProposalDocAction } from "../src/proposal-doc-action.ts";
import { SqliteD1, TENANT, auth, env, request } from "./company-setup-fixture.ts";

/**
 * The deployed reference configuration, copied from `workers-bus/wrangler.jsonc`'s top-level
 * `vars` for exactly the bindings this signal reads, with no secret set. This is the state G1.3
 * audited on `main` @ `3da7ee2b`; every "what does the reference deployment say" assertion below
 * runs against it rather than against an invented environment.
 */
const REFERENCE_VARS: Record<string, string> = {
  EFFECT_RUNTIME_ENABLED: "true",
  APP_DOCUMENT_GENERATION_ENABLED: "false",
  QB_OAUTH_ENABLED: "false",
  QB_FINAL_INVOICE_ENABLED: "false",
  QB_API_ENVIRONMENT: "production",
  QB_API_MINOR_VERSION: "75",
  QB_TOKEN_ENCRYPTION_KEY_VERSION: "",
  NEWO_ENABLED: "false",
  NEWO_API_BASE_URL: "https://api.newo.ai",
  NEWO_PROJECT_ID: "",
  NEWO_AGENT_ID: "",
  POSTIZ_ENABLED: "false",
  POSTIZ_API_BASE_URL: "",
  PUBLIC_ESTIMATE_ENABLED: "false",
  PUBLIC_ESTIMATE_ALLOWED_ORIGINS: "",
  PUBLIC_ESTIMATE_ALLOWED_BRANDS: "",
  PUBLIC_ESTIMATE_CONSENT_JURISDICTION: "",
  PUBLIC_ESTIMATE_TURNSTILE_SITE_KEY: "",
  PUBLIC_ESTIMATE_RATE_LIMIT_WINDOW_SECONDS: "",
  PUBLIC_ESTIMATE_RATE_LIMIT_IP_MAX: "",
  PUBLIC_ESTIMATE_RATE_LIMIT_CLIENT_MAX: "",
  PUBLIC_ESTIMATE_RANGE_RULES_JSON: "",
  APP_HERMES_DESKTOP_ENABLED: "false",
  FACET_DESIGN_INGEST_ENABLED: "false",
  FACET_V2_INGEST_ENABLED: "true",
  FACET_V2_ROUTES_JSON: "[]",
  FACET_V2_NATIVE_PROJECTION_ENABLED: "true",
  FACET_DESIGN_FRAPPE_PROJECTION_ENABLED: "false",
  APP_FACET_QUOTE_REVISION_PREPARE_ENABLED: "false",
  APP_PROPOSAL_PUBLICATION_ENABLED: "false",
  APP_FACET_LAUNCH_ENABLED: "true",
  APP_FACET_LAUNCH_BASE_URL: "",
  APP_FACET_LAUNCH_SOURCE_TENANT_ID: "",
  PROPOSAL_TEMPLATE_DOC_ID: "",
  SHARED_DRIVE_ID_JOBS: "0AHqXhIQ3svySUk9PVA",
  APP_PUBLIC_ORIGIN: "https://app.example.invalid",
};

const SOURCE_TENANT = "6b0cbf1d-e0a7-4a1f-9b8b-9f2e4a1c77aa";

function facetRoute(destinationTenantId: string): Record<string, unknown> {
  return {
    version: 1,
    issuer: "facet",
    source_product: "facet",
    source_environment: "production",
    source_tenant_id: SOURCE_TENANT,
    destination_tenant_id: destinationTenantId,
    destination_url: "https://facet.example.invalid/projects",
  };
}

function signals(
  overrides: Record<string, string | undefined> = {},
  options: { opaque?: ReadonlySet<string> } = {},
): Record<CapabilitySignalId, CapabilitySignalItem> {
  const values: Record<string, string | undefined> = { ...REFERENCE_VARS, ...overrides };
  return evaluateCapabilitySignals({
    read: (name) => values[name],
    opaque: options.opaque,
  });
}

function appEnv(db: SqliteD1, overrides: Record<string, unknown> = {}): AppEnv {
  return env(db, { ...REFERENCE_VARS, ...overrides } as Partial<AppEnv>);
}

/**
 * The reference deployment's own answer, capability by capability. Any change to `wrangler.jsonc`
 * that moves one of these has to argue with this table first -- the same role
 * `test/app-migration.test.ts` plays for the raw flag defaults, one layer up at the state the UI
 * is actually told.
 */
test("the reference configuration produces the exact state table G1.3 audited", () => {
  const evaluated = signals();
  assert.deepEqual(
    Object.fromEntries(
      CAPABILITY_SIGNAL_IDS.map((id) => [id, `${evaluated[id].state}:${evaluated[id].reason}`]),
    ),
    {
      document_generation: "off:flag_off",
      effect_runtime: "available:flag_on_and_configured",
      facet_design_ingest: "unconfigured:configuration_incomplete",
      facet_design_ingest_v1: "absent:no_source_consumer",
      facet_frappe_projection: "off:flag_off",
      facet_launch: "unconfigured:configuration_incomplete",
      facet_native_projection: "dependency_blocked:dependency_unavailable",
      facet_quote_revision_prepare: "absent:no_source_consumer",
      hermes_desktop: "off:flag_off",
      hermes_hosted_reference: "off:flag_undeclared",
      newo: "off:flag_off",
      postiz: "off:flag_off",
      proposal_publication: "off:flag_off",
      proposal_template: "unconfigured:configuration_incomplete",
      public_estimator: "off:flag_off",
      quickbooks_final_invoice: "off:flag_off",
      quickbooks_oauth: "off:flag_off",
    },
  );
});

test("every state in the vocabulary is reachable and none of them is a boolean in disguise", () => {
  const reference = signals();
  const on = signals({ QB_OAUTH_ENABLED: "true" });
  const malformed = signals({ FACET_V2_ROUTES_JSON: "{not json", FACET_V2_KEYS_JSON: "[{}]" });

  const observed = new Set([
    reference.facet_design_ingest_v1.state,
    reference.hermes_desktop.state,
    reference.facet_design_ingest.state,
    reference.facet_native_projection.state,
    reference.effect_runtime.state,
    malformed.facet_design_ingest.state,
  ]);
  assert.deepEqual(
    [...observed].sort(),
    ["absent", "available", "dependency_blocked", "off", "unconfigured", "unknown"],
  );

  // The three the acceptance criteria name explicitly, side by side, from one configuration.
  assert.equal(reference.facet_design_ingest_v1.state, "absent");
  assert.equal(reference.hermes_desktop.state, "off");
  assert.equal(on.quickbooks_oauth.state, "unconfigured");
});

test("flag state and readiness state are separate fields and never substitute for each other", () => {
  // Flag on, credentials absent: not "off", not "available". Both facts survive intact.
  const on = signals({ QB_OAUTH_ENABLED: "true" }).quickbooks_oauth;
  assert.equal(on.flag.state, "on");
  assert.equal(on.flag.declared, "true");
  assert.equal(on.state, "unconfigured");
  assert.equal(on.configuration.state, "incomplete");
  assert.ok(on.configuration.missing.includes("QB_CLIENT_ID"));

  // Flag off over the same missing credentials: the flag is the whole answer and the
  // configuration is not evaluated, so an off capability leaks nothing about its credentials.
  const off = signals().quickbooks_oauth;
  assert.equal(off.flag.state, "off");
  assert.equal(off.state, "off");
  assert.deepEqual(off.configuration, {
    state: "not_evaluated",
    missing: [],
    indeterminate: [],
  });

  // Flag on over complete configuration: on AND configured, still not a proof claim.
  const ready = signals({
    QB_OAUTH_ENABLED: "true",
    QB_CLIENT_ID: "client",
    QB_CLIENT_SECRET: "secret",
    QB_TOKEN_ENCRYPTION_KEY: "key",
    QB_TOKEN_ENCRYPTION_KEY_VERSION: "v1",
  }).quickbooks_oauth;
  assert.equal(ready.state, "available");
  assert.equal(ready.configuration.state, "configured");
});

test("an undeclared flag and an unparseable flag value are distinct from a declared false", () => {
  const undeclared = signals().hermes_hosted_reference;
  assert.equal(undeclared.flag.state, "undeclared");
  assert.equal(undeclared.flag.declared, null);
  assert.equal(undeclared.reason, "flag_undeclared");

  const declaredFalse = signals().hermes_desktop;
  assert.equal(declaredFalse.flag.state, "off");
  assert.equal(declaredFalse.flag.declared, "false");
  assert.equal(declaredFalse.reason, "flag_off");

  // `"1"` is not the literal any Worker gate accepts. Reporting it as a plain `off` would hide an
  // operator error that reads, to the operator, like it worked.
  for (const value of ["1", "yes", "TRUE", "True"]) {
    const invalid = signals({ APP_HERMES_DESKTOP_ENABLED: value }).hermes_desktop;
    assert.equal(invalid.flag.state, "invalid", value);
    assert.equal(invalid.state, "off", value);
    assert.equal(invalid.reason, "flag_value_invalid", value);
  }
});

test("an unreadable input reports unknown with a readback obligation, never a confident ready", () => {
  // Set but uninterpretable: neither present nor missing is honest.
  const malformed = signals({
    FACET_V2_ROUTES_JSON: "{not json",
    FACET_V2_KEYS_JSON: "[{}]",
  }).facet_design_ingest;
  assert.equal(malformed.state, "unknown");
  assert.equal(malformed.reason, "configuration_indeterminate");
  assert.equal(malformed.readback_required, true);
  assert.deepEqual(malformed.configuration.indeterminate, ["FACET_V2_ROUTES_JSON"]);

  // A caller that cannot observe secrets -- which is `tools/production-readiness.mjs`, not the
  // Worker -- gets `unknown` for the secret-backed part rather than an assumption in either
  // direction. G1.3 unknown #1: whether any Worker secret is actually set.
  const opaque = signals(
    {
      QB_OAUTH_ENABLED: "true",
      QB_TOKEN_ENCRYPTION_KEY_VERSION: "v1",
    },
    { opaque: new Set(["QB_CLIENT_ID", "QB_CLIENT_SECRET", "QB_TOKEN_ENCRYPTION_KEY"]) },
  ).quickbooks_oauth;
  assert.equal(opaque.state, "unknown");
  assert.equal(opaque.readback_required, true);
  assert.deepEqual(opaque.configuration.indeterminate, [
    "QB_CLIENT_ID",
    "QB_CLIENT_SECRET",
    "QB_TOKEN_ENCRYPTION_KEY",
  ]);

  // An unknown dependency propagates as unknown, not as a confident block.
  const unknownDependency = signals(
    { POSTIZ_ENABLED: "true", POSTIZ_API_BASE_URL: "https://postiz.example.invalid" },
    { opaque: new Set(["POSTIZ_API_KEY"]) },
  ).postiz;
  assert.equal(unknownDependency.state, "unknown");
  assert.equal(unknownDependency.readback_required, true);
});

test("a capability whose own parser refuses complete bindings says so, not \"incomplete\"", () => {
  const db = new SqliteD1({ seedUsers: ["owner"] });
  // Every binding the launch capability names is non-blank, so the binding sweep is satisfied --
  // and `facetLaunchConfigured` still refuses, because no static route names this tenant.
  const environment = appEnv(db, {
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE_TENANT,
    FACET_LAUNCH_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
    FACET_V2_ROUTES_JSON: JSON.stringify([facetRoute("a-different-tenant")]),
  });
  const item = buildCapabilitySignalReadModel(environment, auth("owner")).capabilities.find(
    (candidate) => candidate.id === "facet_launch",
  ) as OfficeCapabilityItem;
  assert.equal(item.state, "unconfigured");
  // The distinction that matters to whoever has to fix it: nothing is blank, so pointing at a
  // missing binding would send them looking for one that does not exist.
  assert.equal(item.reason, "configuration_rejected");
  assert.deepEqual(item.missing_configuration, []);
});

test("a definitively missing binding outranks an unreadable one, because it is actionable", () => {
  const item = signals(
    { POSTIZ_ENABLED: "true", POSTIZ_API_BASE_URL: "" },
    { opaque: new Set(["POSTIZ_API_KEY"]) },
  ).postiz;
  assert.equal(item.state, "unconfigured");
  assert.deepEqual(item.configuration.missing, ["POSTIZ_API_BASE_URL"]);
  assert.deepEqual(item.configuration.indeterminate, ["POSTIZ_API_KEY"]);
  // The readback obligation survives the more actionable verdict rather than being dropped.
  assert.equal(item.readback_required, true);
});

test("a failed dependency is its own state, distinguishable from off and from unconfigured", () => {
  const reference = signals();
  const projection = reference.facet_native_projection;
  assert.equal(projection.flag.state, "on");
  assert.equal(projection.configuration.state, "configured");
  assert.equal(projection.state, "dependency_blocked");
  assert.deepEqual(projection.dependencies, [
    { id: "facet_design_ingest", state: "unconfigured" },
  ]);

  // Switching the effect ledger off blocks every provider adapter that fails closed against it,
  // and does so without pretending their own flags or credentials changed.
  const ledgerOff = signals({
    EFFECT_RUNTIME_ENABLED: "false",
    APP_DOCUMENT_GENERATION_ENABLED: "true",
  });
  assert.equal(ledgerOff.effect_runtime.state, "off");
  assert.equal(ledgerOff.document_generation.state, "dependency_blocked");
  assert.equal(ledgerOff.document_generation.flag.state, "on");
  assert.deepEqual(ledgerOff.document_generation.dependencies, [
    { id: "effect_runtime", state: "off" },
  ]);
});

test("an absent capability is reported as absent and never as a disabled one", () => {
  for (const id of ["facet_design_ingest_v1", "facet_quote_revision_prepare"] as const) {
    const item = signals({ [CAPABILITY_SIGNAL_REGISTRY[id].flagBinding!]: "true" })[id];
    // Even with the flag turned on, an id with no consumer in `src/` describes nothing a user
    // gets, so the flag cannot promote it into a capability.
    assert.equal(item.presence, "absent", id);
    assert.equal(item.state, "absent", id);
    assert.equal(item.reason, "no_source_consumer", id);
  }
});

test("the registry covers the eight capabilities spec 9.3 names and every id is presentable", () => {
  for (const id of NAMED_REFERENCE_CAPABILITY_IDS) {
    assert.ok(CAPABILITY_SIGNAL_IDS.includes(id), `${id} missing from the registry`);
  }
  for (const id of CAPABILITY_SIGNAL_IDS) {
    const definition = CAPABILITY_SIGNAL_REGISTRY[id];
    assert.equal(definition.id, id);
    assert.ok(definition.title.length > 0, `${id} needs a title a surface can render`);
    assert.ok(definition.audience.length > 0, `${id} needs at least one audience permission`);
    assert.ok(definition.note.length > 0, `${id} needs a recorded reason for its audience`);
  }
  assert.deepEqual([...CAPABILITY_SIGNAL_IDS], [...CAPABILITY_SIGNAL_IDS].sort());
});

test("the office projection carries operator detail and the scoped one deliberately does not", async () => {
  const db = new SqliteD1({ seedUsers: ["owner", "sales"] });
  const environment = appEnv(db);

  const office = buildCapabilitySignalReadModel(environment, auth("owner"));
  assert.equal(office.projection, "office");
  assert.equal(office.proof_claimed, false);
  assert.equal(office.configuration_mutations_available, false);
  assert.deepEqual(office.allowed_actions, ["capabilities.read"]);
  const officeFacet = office.capabilities.find(
    (item) => item.id === "facet_design_ingest",
  ) as OfficeCapabilityItem;
  assert.equal(officeFacet.state, "unconfigured");
  assert.equal(officeFacet.flag_binding, "FACET_V2_INGEST_ENABLED");
  assert.deepEqual(officeFacet.missing_configuration, [
    "FACET_V2_ROUTES_JSON",
    "FACET_V2_KEYS_JSON",
  ]);

  const scoped = buildCapabilitySignalReadModel(environment, auth("sales"));
  assert.equal(scoped.projection, "scoped");
  const scopedFacet = scoped.capabilities.find(
    (item) => item.id === "facet_design_ingest",
  ) as ScopedCapabilityItem;
  // Same honest state, none of the infrastructure detail: no binding name, no declared literal,
  // no dependency graph. A capability state leaks commercial and infrastructure facts, so a
  // non-office role gets the minimum that lets its UI be honest.
  assert.equal(scopedFacet.state, "unconfigured");
  assert.equal(scopedFacet.reason, "configuration_incomplete");
  assert.deepEqual(Object.keys(scopedFacet).sort(), [
    "configuration_state",
    "flag_state",
    "id",
    "presence",
    "readback_required",
    "reason",
    "state",
    "title",
  ]);
  const serialized = JSON.stringify(scoped);
  for (const leaked of ["FACET_V2_INGEST_ENABLED", "FACET_V2_ROUTES_JSON", "QB_CLIENT_ID"]) {
    assert.ok(!serialized.includes(leaked), `${leaked} must not reach a non-office role`);
  }
});

test("the signal reaches every authenticated role, scoped to what that role can act on", async () => {
  const roles: AppRole[] = ["owner", "ops", "sales", "production", "accounting", "field"];
  const db = new SqliteD1({ seedUsers: roles });
  const environment = appEnv(db);
  const seen: Record<string, string[]> = {};

  for (const role of roles) {
    const response = await handleAuthenticatedRoute(
      new Request("https://app.example.invalid/api/v1/capabilities"),
      environment,
      auth(role),
    );
    assert.equal(response.status, 200, role);
    assert.equal(response.headers.get("cache-control"), "private, no-store", role);
    const body = (await response.json()) as {
      role: string;
      tenant_id: string;
      capabilities: Array<{ id: string }>;
    };
    assert.equal(body.role, role);
    assert.equal(body.tenant_id, TENANT);
    seen[role] = body.capabilities.map((item) => item.id).sort();
  }

  // Non-office roles receive real capability facts without the office readiness view: accounting
  // learns the QuickBooks state, sales learns the estimator and proposal states, production
  // learns whether governed document generation can run.
  assert.deepEqual(seen.accounting, ["quickbooks_final_invoice", "quickbooks_oauth"]);
  assert.deepEqual(seen.sales, [
    "facet_design_ingest",
    "proposal_publication",
    "proposal_template",
    "public_estimator",
  ]);
  assert.deepEqual(seen.production, ["document_generation"]);
  // `field` holds no permission that reaches any of these sixteen, so its list is empty by
  // derivation rather than by omission -- and the envelope still arrives, so a field-facing
  // capability added to the registry later needs no new mechanism.
  assert.deepEqual(seen.field, []);
  assert.equal(seen.owner!.length, CAPABILITY_SIGNAL_IDS.length);
  assert.deepEqual(seen.ops, seen.owner);
});

test("the office readiness endpoint stays office-only while the capability signal does not", async () => {
  const db = new SqliteD1({ seedUsers: ["accounting"] });
  const environment = appEnv(db);
  const readiness = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/integrations/readiness"),
    environment,
    auth("accounting"),
  );
  assert.equal(readiness.status, 403);
  assert.deepEqual(await readiness.json(), { error: "office_role_required" });

  const capabilities = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/capabilities"),
    environment,
    auth("accounting"),
  );
  assert.equal(capabilities.status, 200);
});

test("capability state is per tenant and no capability fact crosses a tenant boundary", () => {
  const db = new SqliteD1({ seedUsers: ["owner"] });
  const configured = {
    APP_FACET_LAUNCH_ENABLED: "true",
    APP_FACET_LAUNCH_BASE_URL: "https://facet.example.invalid/",
    APP_FACET_LAUNCH_SOURCE_TENANT_ID: SOURCE_TENANT,
    FACET_LAUNCH_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
    FACET_V2_ROUTES_JSON: JSON.stringify([facetRoute(TENANT)]),
  };
  const environment = appEnv(db, configured);

  const own = buildCapabilitySignalReadModel(environment, auth("owner"));
  const ownLaunch = own.capabilities.find((item) => item.id === "facet_launch")!;
  assert.equal(ownLaunch.state, "available");

  // Identical bindings, a session belonging to a different tenant: the same static route set
  // resolves to nothing for that tenant, and it is told `unconfigured` rather than the other
  // tenant's `available`.
  const other = buildCapabilitySignalReadModel(environment, auth("owner", "other-tenant"));
  const otherLaunch = other.capabilities.find((item) => item.id === "facet_launch")!;
  assert.equal(other.tenant_id, "other-tenant");
  assert.equal(otherLaunch.state, "unconfigured");
});

test("the state is derived per request, never from a client value or a cached constant", async () => {
  const db = new SqliteD1({ seedUsers: ["owner"] });
  const mutable = appEnv(db) as AppEnv & Record<string, string>;

  const before = buildCapabilitySignalReadModel(mutable, auth("owner"));
  assert.equal(
    before.capabilities.find((item) => item.id === "hermes_desktop")!.state,
    "off",
  );

  mutable.APP_HERMES_DESKTOP_ENABLED = "true";
  const after = buildCapabilitySignalReadModel(mutable, auth("owner"));
  assert.equal(
    after.capabilities.find((item) => item.id === "hermes_desktop")!.state,
    "available",
  );

  // Nothing in the request can move a capability: no query parameter, header, or body is read.
  const injected = await handleAuthenticatedRoute(
    new Request(
      "https://app.example.invalid/api/v1/capabilities?tenant_id=other-tenant" +
        "&hermes_desktop=off&projection=office",
      { headers: { "x-capability-state": "available" } },
    ),
    appEnv(db),
    auth("sales"),
  );
  const body = (await injected.json()) as { tenant_id: string; projection: string };
  assert.equal(body.tenant_id, TENANT);
  assert.equal(body.projection, "scoped");
});

test("the field bootstrap carries the signal so an offline device needs no second call", async () => {
  const db = new SqliteD1({ seedUsers: ["field"] });
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/field/bootstrap"),
    appEnv(db),
    auth("field"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    capabilities: { version: number; projection: string; proof_claimed: boolean };
  };
  assert.equal(body.capabilities.version, 1);
  assert.equal(body.capabilities.projection, "scoped");
  assert.equal(body.capabilities.proof_claimed, false);
});

/**
 * The two on-but-unconfigured routes G1.3 named, proved to answer exactly what the signal says
 * they answer. A capability state that did not match the route's own refusal would be a second
 * dishonest surface, not a fix for the first.
 */
test("on-but-unconfigured Facet ingest answers 503 and the signal says unconfigured, not off", async () => {
  const db = new SqliteD1();
  const environment = appEnv(db);
  assert.equal(signals().facet_design_ingest.state, "unconfigured");

  const response = await handleFacetDesignIngest(
    new Request("https://bus.example.invalid/ingest/facet-design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    environment as unknown as Env,
  );
  // On, so not the 404 a disabled route would give; unconfigured, so 503 rather than a 4xx that
  // would blame the caller.
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "facet_v2_ingest_unavailable" });

  const off = await handleFacetDesignIngest(
    new Request("https://bus.example.invalid/ingest/facet-design", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    appEnv(db, { FACET_V2_INGEST_ENABLED: "false" }) as unknown as Env,
  );
  assert.equal(off.status, 404);
  assert.equal(signals({ FACET_V2_INGEST_ENABLED: "false" }).facet_design_ingest.state, "off");
});

test("the unflagged proposal template answers 503 not_configured and the signal agrees", async () => {
  const db = new SqliteD1({ seedUsers: ["sales"] });
  const item = signals().proposal_template;
  assert.equal(item.flag.state, "not_flagged");
  assert.equal(item.state, "unconfigured");
  assert.deepEqual(item.configuration.missing, [
    "PROPOSAL_TEMPLATE_DOC_ID",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
  ]);

  const response = await handleProposalDocAction(
    request("POST", "/api/v1/estimator/proposal-doc", { payload: { jobNumber: "JN-1" } }),
    appEnv(db),
    auth("sales"),
  );
  // Mounted unconditionally, so an estimator is offered the action and it fails at first use.
  // "Not configured" is what the signal must say; "unavailable" would be actively misleading.
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "proposal_doc_not_configured" });
});
