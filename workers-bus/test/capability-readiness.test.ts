import assert from "node:assert/strict";
import { test } from "node:test";

import { handleAuthenticatedRoute } from "../src/app-api.ts";
import {
  CAPABILITY_ACTION_REGISTRY,
  CAPABILITY_ACTION_REGISTRY_REF,
  CAPABILITY_AUTHORITY_REGISTRY_REF,
  CAPABILITY_IDS,
  buildCapabilityReadinessReadModel,
  evaluateCapabilityReadiness,
  type CapabilityReadinessReadModel,
  type CapabilityId,
  type CapabilityReadinessDataset,
} from "../src/capability-readiness.ts";
import { NOW, SqliteD1, TENANT, USERS, auth, env } from "./company-setup-fixture.ts";

const SOURCE_COMMIT = "d71941e7f51ded5f677a6b497b09c64c5ca32baf";
const OBSERVED_AT = "2026-08-24T00:00:00.000Z";
const EXPIRES_AT = "2026-08-25T00:00:00.000Z";
const EVALUATED_AT = new Date("2026-08-24T12:00:00.000Z");

const requiredByProfile = {
  core: [
    "email_delivery",
    "magic_link",
    "cloudflare_worker",
    "pwa",
    "d1",
    "r2",
    "queues",
    "backup_restore",
    "observability",
  ],
  commercial_closure: ["facet_association", "measurement_ocr", "communications_rail"],
  field_closure: ["supplier_rail"],
  accounting_closure: ["quickbooks"],
  reference_journey: [],
} as const satisfies Record<string, readonly CapabilityId[]>;

const dependenciesByProfile = {
  core: [],
  commercial_closure: ["core"],
  field_closure: ["core"],
  accounting_closure: ["core"],
  reference_journey: ["core", "commercial_closure", "field_closure", "accounting_closure"],
} as const;

const READY_DB = readyDatabase();
const READY_DATASET = dataset(READY_DB);

test("exact reference profile is ready while an explicitly optional Newo capability is nonblocking", () => {
  const data = structuredClone(READY_DATASET);
  const result = evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT);

  assert.equal(result.verdict, "ready");
  assert.equal(result.profile.state, "ready");
  assert.equal(result.capabilities.filter((capability) => capability.required).length, 14);
  const newo = capability(result, "newo");
  assert.equal(newo.required, false);
  assert.equal(newo.state, "blocked");
  assert.deepEqual(newo.blockers, ["manifest_missing", "proof_missing"]);
});

test("proof TTL, credential binding, realm, route, and sender identity drift all fail closed", () => {
  const base = READY_DATASET;
  const cases: Array<{
    name: string;
    mutate: (data: CapabilityReadinessDataset) => void;
    blocker: string;
  }> = [
    {
      name: "expired",
      mutate: (data) => {
        data.proofs.find((proof) => proof.capability_id === "email_delivery")!.expires_at =
          "2026-08-24T01:00:00.000Z";
      },
      blocker: "proof_expired",
    },
    {
      name: "credential binding drift without exposing a secret",
      mutate: (data) => {
        data.proofs.find(
          (proof) => proof.capability_id === "email_delivery",
        )!.credential_binding_digest_sha256 = "0".repeat(64);
      },
      blocker: "credential_binding_digest_drift",
    },
    {
      name: "realm drift",
      mutate: (data) => {
        data.proofs.find((proof) => proof.capability_id === "email_delivery")!.provider_realm_ref =
          "realm:foreign";
      },
      blocker: "realm_drift",
    },
    {
      name: "route drift",
      mutate: (data) => {
        data.proofs.find((proof) => proof.capability_id === "email_delivery")!.route_digest_sha256 =
          "0".repeat(64);
      },
      blocker: "route_digest_drift",
    },
    {
      name: "unverified sender/provider principal",
      mutate: (data) => {
        data.proofs.find(
          (proof) => proof.capability_id === "email_delivery",
        )!.provider_identity_verified = 0;
      },
      blocker: "provider_identity_unverified",
    },
  ];

  for (const scenario of cases) {
    const data = structuredClone(base);
    scenario.mutate(data);
    const result = evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT);
    assert.equal(result.verdict, "blocked", scenario.name);
    assert.ok(
      capability(result, "email_delivery").blockers.includes(scenario.blocker),
      scenario.name,
    );
  }
});

test("proof timestamps require canonical UTC instants and reject observations beyond five minutes of clock skew", () => {
  const malformedCases: Array<{ observedAt: string; expiresAt: string }> = [
    { observedAt: "2026-08-24T00:00:00Z", expiresAt: "2026-08-25T00:00:00Z" },
    { observedAt: "not-a-date", expiresAt: "also-not-a-date" },
  ];

  for (const malformed of malformedCases) {
    const data = structuredClone(READY_DATASET);
    const proof = data.proofs.find((row) => row.capability_id === "email_delivery")!;
    proof.observed_at = malformed.observedAt;
    proof.expires_at = malformed.expiresAt;
    const result = evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT);
    assert.ok(
      capability(result, "email_delivery").blockers.includes("proof_timestamp_invalid"),
      malformed.observedAt,
    );
  }

  const materiallyFuture = structuredClone(READY_DATASET);
  const futureProof = materiallyFuture.proofs.find((row) => row.capability_id === "email_delivery")!;
  futureProof.observed_at = "2026-08-24T12:05:01.000Z";
  futureProof.expires_at = "2026-08-25T12:05:01.000Z";
  const futureResult = evaluateCapabilityReadiness("reference_journey", materiallyFuture, EVALUATED_AT);
  assert.ok(capability(futureResult, "email_delivery").blockers.includes("proof_observed_in_future"));

  const withinCeiling = structuredClone(READY_DATASET);
  const withinProof = withinCeiling.proofs.find((row) => row.capability_id === "email_delivery")!;
  withinProof.observed_at = "2026-08-24T12:05:00.000Z";
  withinProof.expires_at = "2026-08-25T12:05:00.000Z";
  assert.ok(!capability(
    evaluateCapabilityReadiness("reference_journey", withinCeiling, EVALUATED_AT),
    "email_delivery",
  ).blockers.includes("proof_observed_in_future"));
});

test("disabled required actions, missing rollback, and arbitrary hook actions are rejected", () => {
  const base = READY_DATASET;
  const cases: Array<{
    mutate: (data: CapabilityReadinessDataset) => void;
    blocker: string;
  }> = [
    {
      mutate: (data) => {
        const manifest = data.manifests.find((row) => row.capability_id === "email_delivery")!;
        const actions = JSON.parse(manifest.actions_json) as Array<{
          name: string;
          enabled: boolean;
        }>;
        actions[0]!.enabled = false;
        manifest.actions_json = JSON.stringify(actions);
      },
      blocker: "required_action_disabled:email.send",
    },
    {
      mutate: (data) => {
        data.manifests.find((row) => row.capability_id === "email_delivery")!.rollback_contract =
          "none";
      },
      blocker: "rollback_missing",
    },
    {
      mutate: (data) => {
        const manifest = data.manifests.find((row) => row.capability_id === "email_delivery")!;
        const actions = JSON.parse(manifest.actions_json) as Array<{
          name: string;
          enabled: boolean;
        }>;
        actions.push({ name: "provider.arbitrary_hook", enabled: true });
        manifest.actions_json = JSON.stringify(actions);
      },
      blocker: "unsupported_action:provider.arbitrary_hook",
    },
  ];

  for (const scenario of cases) {
    const data = structuredClone(base);
    scenario.mutate(data);
    const result = evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT);
    assert.equal(result.verdict, "blocked");
    assert.ok(capability(result, "email_delivery").blockers.includes(scenario.blocker));
  }
});

test("every execution contract and mutation auth scope is required", () => {
  const contractCases = [
    ["idempotency_contract", "idempotency_contract_missing"],
    ["retry_contract", "retry_contract_missing"],
    ["readback_contract", "readback_contract_missing"],
    ["reconciliation_contract", "reconciliation_contract_missing"],
  ] as const;

  for (const [field, blocker] of contractCases) {
    const data = structuredClone(READY_DATASET);
    data.manifests.find((row) => row.capability_id === "email_delivery")![field] = "none";
    assert.ok(capability(
      evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT),
      "email_delivery",
    ).blockers.includes(blocker), field);
  }

  const missingScopes = structuredClone(READY_DATASET);
  missingScopes.manifests.find((row) => row.capability_id === "email_delivery")!
    .auth_scope_names_json = "[]";
  assert.ok(capability(
    evaluateCapabilityReadiness("reference_journey", missingScopes, EVALUATED_AT),
    "email_delivery",
  ).blockers.includes("auth_scope_names_missing"));

  const mislabeledProvider = structuredClone(READY_DATASET);
  const email = mislabeledProvider.manifests.find(
    (row) => row.capability_id === "email_delivery",
  )!;
  email.direction = "internal";
  email.auth_scope_names_json = "[]";
  mislabeledProvider.effect_runtime_ready = false;
  const mislabeled = capability(
    evaluateCapabilityReadiness(
      "reference_journey",
      mislabeledProvider,
      EVALUATED_AT,
    ),
    "email_delivery",
  );
  for (const blocker of [
    "provider_direction_invalid",
    "auth_scope_names_missing",
    "effect_runtime_unready",
  ])
    assert.ok(mislabeled.blockers.includes(blocker), blocker);

  const internalReadback = structuredClone(READY_DATASET);
  internalReadback.manifests.find((row) => row.capability_id === "cloudflare_worker")!
    .auth_scope_names_json = "[]";
  assert.ok(!capability(
    evaluateCapabilityReadiness("reference_journey", internalReadback, EVALUATED_AT),
    "cloudflare_worker",
  ).blockers.includes("auth_scope_names_missing"));
});

test("provider mutations require the canonical effect runtime and live realms stay exact", () => {
  const noEffectRuntime = structuredClone(READY_DATASET);
  noEffectRuntime.effect_runtime_ready = false;
  const effectResult = evaluateCapabilityReadiness(
    "reference_journey",
    noEffectRuntime,
    EVALUATED_AT,
  );
  assert.ok(capability(effectResult, "email_delivery").blockers.includes("effect_runtime_unready"));

  const foreignRealm = structuredClone(READY_DATASET);
  foreignRealm.current_realm_refs = { quickbooks: "foreign-company-realm" };
  const realmResult = evaluateCapabilityReadiness("reference_journey", foreignRealm, EVALUATED_AT);
  assert.ok(capability(realmResult, "quickbooks").blockers.includes("realm_drift"));
});

test("required live signals fail closed when omitted while declared evidence-only rails use fresh proof", () => {
  const missingEmailSignal = structuredClone(READY_DATASET);
  delete missingEmailSignal.runtime?.email_delivery;
  assert.ok(capability(
    evaluateCapabilityReadiness("reference_journey", missingEmailSignal, EVALUATED_AT),
    "email_delivery",
  ).blockers.includes("runtime_unready"));

  const evidenceOnly = structuredClone(READY_DATASET);
  delete evidenceOnly.runtime?.backup_restore;
  delete evidenceOnly.runtime?.observability;
  delete evidenceOnly.runtime?.supplier_rail;
  const result = evaluateCapabilityReadiness("reference_journey", evidenceOnly, EVALUATED_AT);
  for (const id of ["backup_restore", "observability", "supplier_rail"] as const)
    assert.ok(!capability(result, id).blockers.includes("runtime_unready"), id);
});

test("missing dependencies and ambiguous profile, manifest, or proof heads fail closed", () => {
  const base = READY_DATASET;

  const missingDependency = structuredClone(base);
  missingDependency.profiles = missingDependency.profiles.filter(
    (profile) => profile.profile_key !== "core",
  );
  const missingResult = evaluateCapabilityReadiness(
    "reference_journey",
    missingDependency,
    EVALUATED_AT,
  );
  assert.equal(missingResult.verdict, "blocked");
  assert.ok(missingResult.profile.blockers.includes("profile_dependency_blocked:core"));

  const ambiguousProfile = structuredClone(base);
  ambiguousProfile.profiles.push({
    ...ambiguousProfile.profiles.find((profile) => profile.profile_key === "reference_journey")!,
    profile_id: "profile_reference_duplicate",
  });
  assert.ok(
    evaluateCapabilityReadiness(
      "reference_journey",
      ambiguousProfile,
      EVALUATED_AT,
    ).profile.blockers.includes("profile_head_ambiguous"),
  );

  const ambiguousManifest = structuredClone(base);
  ambiguousManifest.manifests.push({
    ...ambiguousManifest.manifests.find((manifest) => manifest.capability_id === "email_delivery")!,
    manifest_id: "manifest_email_duplicate",
  });
  assert.ok(
    capability(
      evaluateCapabilityReadiness("reference_journey", ambiguousManifest, EVALUATED_AT),
      "email_delivery",
    ).blockers.includes("manifest_head_ambiguous"),
  );

  const ambiguousProof = structuredClone(base);
  ambiguousProof.proofs.push({
    ...ambiguousProof.proofs.find((proof) => proof.capability_id === "email_delivery")!,
    proof_id: "proof_email_duplicate",
  });
  assert.ok(
    capability(
      evaluateCapabilityReadiness("reference_journey", ambiguousProof, EVALUATED_AT),
      "email_delivery",
    ).blockers.includes("proof_head_ambiguous"),
  );
});

test("a failed required capability blocks every profile that depends on its profile", () => {
  const data = structuredClone(READY_DATASET);
  data.proofs.find((proof) => proof.capability_id === "email_delivery")!.expires_at =
    "2026-08-24T01:00:00.000Z";

  const result = evaluateCapabilityReadiness("reference_journey", data, EVALUATED_AT);

  assert.equal(result.verdict, "blocked");
  assert.equal(
    result.profile.dependencies.find((dependency) => dependency.key === "core")?.state,
    "blocked",
  );
  assert.ok(result.profile.blockers.includes("profile_dependency_blocked:core"));
});

test("migration facts are append-only and proof facts cannot cross manifest identity", () => {
  const db = READY_DB;
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE capability_integration_manifests SET enabled = 0 WHERE capability_id = 'email_delivery'",
        )
        .run(),
    /capability_integration_manifests_append_only/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare("DELETE FROM capability_proof_facts WHERE capability_id = 'email_delivery'")
        .run(),
    /capability_proof_facts_retained/,
  );
  assert.throws(
    () =>
      insertProof(db, "email_delivery", {
        providerKey: "foreign-provider",
        proofVersion: 2,
      }),
    /capability_proof_manifest_binding_mismatch/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(
          "UPDATE capability_readiness_profiles SET capabilities_json = '[]' WHERE profile_key = 'core'",
        )
        .run(),
    /capability_readiness_profiles_append_only/,
  );
});

test("integration readiness API is denied outside owner and operations roles", async () => {
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/integrations/readiness"),
    env(READY_DB),
    auth("sales"),
  );
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "office_role_required" });
});

test("integration readiness API returns the tenant-scoped D1 projection to an owner", async () => {
  const response = await handleAuthenticatedRoute(
    new Request("https://app.example.invalid/api/v1/integrations/readiness"),
    env(READY_DB),
    auth("owner"),
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.tenant_id, TENANT);
  assert.equal(body.configuration_mutations_available, false);
  assert.deepEqual(body.allowed_actions, ["integrations.readiness.read"]);
});

test("read model verifies the complete canonical effect ledger schema before allowing mutations", async () => {
  for (const unavailable of [
    { columns: ["expected_readback_json"], tables: [] },
    { columns: [], tables: ["external_effect_exceptions"] },
    {
      columns: [],
      tables: ["external_effects", "external_effect_attempts", "external_effect_events", "external_effect_exceptions"],
    },
  ]) {
    const db = readyDatabase();
    const model = await buildCapabilityReadinessReadModel(
      env(db, {
        DB: databaseView(db, {
          unavailableColumns: unavailable.columns,
          unavailableTables: unavailable.tables,
        }) as never,
        EFFECT_RUNTIME_ENABLED: "true",
      }),
      TENANT,
      "reference_journey",
      EVALUATED_AT,
    );
    assert.ok(
      readinessCapability(model, "email_delivery").blockers.includes("effect_runtime_unready"),
      [...unavailable.tables, ...unavailable.columns].join(","),
    );
  }
});

test("read model queries only version heads when append-only history exists", { concurrency: false }, async () => {
  const db = readyDatabase();
  insertManifest(db, "email_delivery", {
    manifestId: "capability_manifest_email_delivery_v2",
    manifestVersion: 2,
  });
  insertProof(db, "email_delivery", {
    proofVersion: 2,
    manifestId: "capability_manifest_email_delivery_v2",
    manifestVersion: 2,
  });
  db.raw.prepare(
    `INSERT INTO capability_readiness_profiles
     (profile_id, tenant_id, profile_key, profile_version, profile_digest_sha256,
      capabilities_json, dependencies_json, source_repository, source_commit, source_path,
      owner_user_id, approved_at)
     SELECT 'profile_reference_journey_v2', tenant_id, profile_key, 2, ?, capabilities_json,
            dependencies_json, source_repository, source_commit, source_path, owner_user_id, ?
       FROM capability_readiness_profiles
      WHERE tenant_id = ? AND profile_key = 'reference_journey' AND profile_version = 1`,
  ).run("2".repeat(64), NOW, TENANT);

  const capabilityQueryCounts = new Map<string, number>();
  const model = await buildCapabilityReadinessReadModel(
    env(db, {
      DB: databaseView(db, { capabilityQueryCounts }) as never,
      EFFECT_RUNTIME_ENABLED: "true",
    }),
    TENANT,
    "reference_journey",
    EVALUATED_AT,
  );

  assert.equal(readinessCapability(model, "email_delivery").manifest?.version, 2);
  assert.deepEqual(Object.fromEntries(capabilityQueryCounts), {
    capability_integration_manifests: 14,
    capability_proof_facts: 14,
    capability_readiness_profiles: 5,
  });
});

test("QuickBooks production configuration is live-ready when the connected realm is exact", { concurrency: false }, async () => {
  const db = readyDatabase();
  insertManifest(db, "quickbooks", {
    manifestId: "capability_manifest_quickbooks_v2",
    manifestVersion: 2,
    providerRealmRef: "1234567890",
  });
  insertProof(db, "quickbooks", {
    proofVersion: 2,
    manifestId: "capability_manifest_quickbooks_v2",
    manifestVersion: 2,
    providerRealmRef: "1234567890",
  });
  db.addQuickBooksConnection("connected");
  const model = await buildCapabilityReadinessReadModel(
    env(db, {
      EFFECT_RUNTIME_ENABLED: "true",
      APP_PUBLIC_ORIGIN: "https://app.example.invalid",
      APP_ALLOW_INSECURE_LOCAL: "false",
      QB_API_ENVIRONMENT: "production",
      QB_API_MINOR_VERSION: "75",
      QB_CLIENT_ID: "test-client",
      QB_CLIENT_SECRET: "test-secret",
      QB_TOKEN_ENCRYPTION_KEY: "A".repeat(43),
      QB_TOKEN_ENCRYPTION_KEY_VERSION: "v1",
      QB_EXPECTED_REALM_ID: "1234567890",
    }),
    TENANT,
    "accounting_closure",
    EVALUATED_AT,
  );

  assert.equal(readinessCapability(model, "quickbooks").state, "ready");
});

function databaseView(
  db: SqliteD1,
  options: {
    unavailableColumns?: readonly string[];
    unavailableTables?: readonly string[];
    capabilityQueryCounts?: Map<string, number>;
  },
) {
  const unavailableColumns = new Set(options.unavailableColumns ?? []);
  const unavailableTables = new Set(options.unavailableTables ?? []);
  const capabilityTables = [
    "capability_integration_manifests",
    "capability_proof_facts",
    "capability_readiness_profiles",
  ];
  return {
    prepare(sql: string) {
      for (const table of unavailableTables) {
        if (new RegExp(`\\b${table}\\b`, "iu").test(sql))
          throw new Error(`no such table: ${table}`);
      }
      for (const column of unavailableColumns) {
        if (new RegExp(`\\b${column}\\b`, "iu").test(sql))
          throw new Error(`no such column: ${column}`);
      }
      const statement = db.prepare(sql);
      return {
        bind(...args: unknown[]) {
          const bound = statement.bind(...args);
          return {
            first: <T>() => bound.first<T>(),
            run: () => bound.run(),
            all: async <T>() => {
              const result = await bound.all<T>();
              for (const table of capabilityTables) {
                if (new RegExp(`\\bFROM\\s+${table}\\b`, "iu").test(sql))
                  options.capabilityQueryCounts?.set(table, result.results.length);
              }
              return result;
            },
          };
        },
      };
    },
    batch: db.batch.bind(db),
  };
}

function readinessCapability(model: CapabilityReadinessReadModel, id: CapabilityId) {
  const item = model.capabilities.find((candidate) => candidate.id === id);
  assert.ok(item, `missing capability ${id}`);
  return item;
}

function readyDatabase(): SqliteD1 {
  const db = new SqliteD1({ seedUsers: ["owner"] });
  for (const capabilityId of CAPABILITY_IDS) {
    if (["newo", "postiz", "public_estimator"].includes(capabilityId)) continue;
    insertManifest(db, capabilityId);
    insertProof(db, capabilityId);
  }
  for (const profileKey of Object.keys(requiredByProfile) as Array<
    keyof typeof requiredByProfile
  >) {
    const profileId = `profile_${profileKey}_v1`;
    const capabilities: Array<{
      capability_id: CapabilityId;
      required: boolean;
      ordinal: number;
    }> = requiredByProfile[profileKey].map((capabilityId, ordinal) => ({
      capability_id: capabilityId,
      required: true,
      ordinal,
    }));
    if (profileKey === "reference_journey") {
      capabilities.push({ capability_id: "newo", required: false, ordinal: 100 });
    }
    const dependencies = dependenciesByProfile[profileKey].map((dependency) => ({
      profile_key: dependency,
      minimum_version: 1,
    }));
    db.raw
      .prepare(
        `INSERT INTO capability_readiness_profiles
         (profile_id, tenant_id, profile_key, profile_version, profile_digest_sha256,
          capabilities_json, dependencies_json, source_repository, source_commit, source_path,
          owner_user_id, approved_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 'Iron-Wrap/ironwrap-os', ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        TENANT,
        profileKey,
        "1".repeat(64),
        JSON.stringify(capabilities),
        JSON.stringify(dependencies),
        SOURCE_COMMIT,
        `config/readiness/${profileKey}.json`,
        USERS.owner,
        NOW,
      );
  }
  return db;
}

function insertManifest(
  db: SqliteD1,
  capabilityId: CapabilityId,
  options: {
    manifestId?: string;
    manifestVersion?: number;
    providerRealmRef?: string;
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO capability_integration_manifests
       (manifest_id, tenant_id, capability_id, manifest_version, provider_key,
        provider_realm_ref, provider_realm_digest_sha256, direction, actions_json,
        auth_scope_names_json, data_class, authority_registry_ref, action_registry_ref,
        idempotency_contract, retry_contract, readback_contract, reconciliation_contract,
        enabled, proof_ttl_seconds, safe_fallback, disable_contract, rollback_contract,
        tenant_config_digest_sha256, credential_binding_digest_sha256, route_digest_sha256,
        artifact_digest_sha256, source_repository, source_commit, source_path,
        owner_user_id, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 86400,
       ?, ?, ?, ?, ?, ?, ?, 'Iron-Wrap/ironwrap-os', ?, ?, ?, ?)`,
    )
    .run(
      options.manifestId ?? `capability_manifest_${capabilityId}`,
      TENANT,
      capabilityId,
      options.manifestVersion ?? 1,
      providerFor(capabilityId),
      options.providerRealmRef ?? `realm:${capabilityId}`,
      "e".repeat(64),
      directionFor(capabilityId),
      JSON.stringify(
        CAPABILITY_ACTION_REGISTRY[capabilityId].map((name) => ({
          name,
          enabled: true,
        })),
      ),
      JSON.stringify(["capability.read", "capability.write"]),
      capabilityId === "quickbooks" ? "financial" : "operational",
      CAPABILITY_AUTHORITY_REGISTRY_REF,
      CAPABILITY_ACTION_REGISTRY_REF,
      "Stable tenant intent key; replay returns the original result.",
      "Bounded retry with backoff; uncertainty stops automatic retries.",
      "Provider readback must match the exact tenant, realm, action, and artifact.",
      "Mismatch creates an exception and requires a fresh provider observation.",
      "Stop safely and keep the existing human/provider workflow available.",
      "Disable by adding a new manifest version with enabled false.",
      "Restore the prior verified route only through a newly approved manifest version.",
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      SOURCE_COMMIT,
      `workers-bus/src/${capabilityId}.ts`,
      USERS.owner,
      NOW,
    );
}

function insertProof(
  db: SqliteD1,
  capabilityId: CapabilityId,
  options: {
    providerKey?: string;
    proofVersion?: number;
    manifestId?: string;
    manifestVersion?: number;
    providerRealmRef?: string;
    observedAt?: string;
    expiresAt?: string;
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO capability_proof_facts
       (proof_id, tenant_id, capability_id, proof_version, manifest_id, manifest_version,
        provider_key, provider_realm_ref, provider_realm_digest_sha256,
        verified_actions_json, verification_state, provider_identity_verified,
        tenant_config_digest_sha256, credential_binding_digest_sha256, route_digest_sha256,
        artifact_digest_sha256, readback_digest_sha256, evidence_ref, issuer_ref,
        observed_at, expires_at, recorded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `capability_proof_${capabilityId}_${options.proofVersion ?? 1}`,
      TENANT,
      capabilityId,
      options.proofVersion ?? 1,
      options.manifestId ?? `capability_manifest_${capabilityId}`,
      options.manifestVersion ?? 1,
      options.providerKey ?? providerFor(capabilityId),
      options.providerRealmRef ?? `realm:${capabilityId}`,
      "e".repeat(64),
      JSON.stringify(CAPABILITY_ACTION_REGISTRY[capabilityId]),
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "f".repeat(64),
      `r2://readiness/${capabilityId}/proof.json`,
      `issuer:${providerFor(capabilityId)}`,
      options.observedAt ?? OBSERVED_AT,
      options.expiresAt ?? EXPIRES_AT,
      USERS.owner,
    );
}

function dataset(db: SqliteD1): CapabilityReadinessDataset {
  return {
    manifests: db.raw.prepare("SELECT * FROM capability_integration_manifests").all() as never,
    proofs: db.raw.prepare("SELECT * FROM capability_proof_facts").all() as never,
    profiles: db.raw.prepare("SELECT * FROM capability_readiness_profiles").all() as never,
    runtime: Object.fromEntries(CAPABILITY_IDS.map((id) => [id, true])),
    effect_runtime_ready: true,
  };
}

function providerFor(capabilityId: CapabilityId): string {
  if (capabilityId === "email_delivery" || capabilityId === "communications_rail") return "gmail";
  if (capabilityId === "quickbooks") return "quickbooks";
  if (capabilityId === "measurement_ocr") return "google_document_ai";
  if (capabilityId === "facet_association") return "facet";
  if (capabilityId === "supplier_rail") return "supplier_gateway";
  if (capabilityId === "magic_link") return "ironwrap_app";
  return "cloudflare";
}

function directionFor(capabilityId: CapabilityId): "bidirectional" | "internal" {
  return [
    "cloudflare_worker",
    "pwa",
    "d1",
    "r2",
    "queues",
    "backup_restore",
    "observability",
  ].includes(capabilityId)
    ? "internal"
    : "bidirectional";
}

function capability(result: ReturnType<typeof evaluateCapabilityReadiness>, id: CapabilityId) {
  const item = result.capabilities.find((candidate) => candidate.id === id);
  assert.ok(item, `missing capability ${id}`);
  return item;
}
