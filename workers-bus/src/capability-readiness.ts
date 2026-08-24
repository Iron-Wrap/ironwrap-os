import type { AppEnv } from "./app-types.ts";
import { effectLedgerAvailable } from "./effect-runtime.ts";
import { facetLaunchConfigured } from "./facet-launch.ts";
import { getReadiness, type ReadinessReport } from "./operations.ts";
import { postizConfigured } from "./postiz.ts";
import {
  quickBooksConnectedRealmId,
  quickBooksProviderApiBase,
} from "./quickbooks-final-invoice.ts";

export const CAPABILITY_IDS = [
  "email_delivery",
  "magic_link",
  "facet_association",
  "quickbooks",
  "measurement_ocr",
  "supplier_rail",
  "communications_rail",
  "cloudflare_worker",
  "pwa",
  "d1",
  "r2",
  "queues",
  "backup_restore",
  "observability",
  "newo",
  "postiz",
  "public_estimator",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export const PROOF_MAX_CLOCK_SKEW_SECONDS = 5 * 60;

const LIVE_RUNTIME_SIGNAL_CAPABILITIES: ReadonlySet<CapabilityId> = new Set([
  "email_delivery",
  "magic_link",
  "facet_association",
  "quickbooks",
  "measurement_ocr",
  "communications_rail",
  "cloudflare_worker",
  "pwa",
  "d1",
  "r2",
  "queues",
  "newo",
  "postiz",
  "public_estimator",
]);

/**
 * These three rails have no separate current runtime/config probe in this repository. Their fresh,
 * exact-action proof is the runtime readback. Keeping the set explicit prevents a newly added
 * capability from becoming proof-only merely because runtimeCapabilitySignals omitted it.
 */
const EVIDENCE_ONLY_RUNTIME_READBACK_CAPABILITIES = new Set<CapabilityId>([
  "supplier_rail",
  "backup_restore",
  "observability",
]);

export const READINESS_PROFILE_KEYS = [
  "core",
  "commercial_closure",
  "field_closure",
  "accounting_closure",
  "reference_journey",
] as const;

export type ReadinessProfileKey = (typeof READINESS_PROFILE_KEYS)[number];

export const CAPABILITY_AUTHORITY_REGISTRY_REF = "ironwrap.capability-authority.v1";
export const CAPABILITY_ACTION_REGISTRY_REF = "ironwrap.integration-actions.v1";

/**
 * Closed vocabulary for integration manifests. This is deliberately a small registry rather than
 * an arbitrary hook surface: a new action requires code review, an executor/readback contract, and
 * a new source version before a manifest can claim it.
 */
export const CAPABILITY_ACTION_REGISTRY: Readonly<Record<CapabilityId, readonly string[]>> = {
  email_delivery: ["email.send", "email.delivery.readback"],
  magic_link: ["auth.magic_link.request", "auth.magic_link.consume"],
  facet_association: ["facet_launch.create", "facet_design.read"],
  quickbooks: ["accounting.invoice.submit", "accounting.invoice.readback"],
  measurement_ocr: ["measurement.ocr.capture", "measurement.ocr.readback"],
  supplier_rail: ["supplier.material_list.submit", "supplier.order.readback"],
  communications_rail: ["communications.send", "communications.delivery.readback"],
  cloudflare_worker: ["runtime.worker.readback"],
  pwa: ["runtime.pwa.readback"],
  d1: ["runtime.d1.readback"],
  r2: ["runtime.r2.readback"],
  queues: ["runtime.queue.readback"],
  backup_restore: ["runtime.backup_restore.readback"],
  observability: ["runtime.observability.readback"],
  newo: ["newo.session.readback"],
  postiz: ["postiz.intent.submit", "postiz.intent.readback"],
  public_estimator: ["public_estimate.submit", "public_estimate.readback"],
};

const PROFILE_REQUIREMENTS: Readonly<Record<ReadinessProfileKey, readonly CapabilityId[]>> = {
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
};

const PROFILE_DEPENDENCIES: Readonly<
  Record<ReadinessProfileKey, readonly Exclude<ReadinessProfileKey, "reference_journey">[]>
> = {
  core: [],
  commercial_closure: ["core"],
  field_closure: ["core"],
  accounting_closure: ["core"],
  reference_journey: ["core", "commercial_closure", "field_closure", "accounting_closure"],
};

export interface CapabilityManifest {
  manifest_id: string;
  tenant_id: string;
  capability_id: CapabilityId;
  manifest_version: number;
  provider_key: string;
  provider_realm_ref: string;
  provider_realm_digest_sha256: string;
  direction: "inbound" | "outbound" | "bidirectional" | "internal";
  actions_json: string;
  auth_scope_names_json: string;
  data_class: "public" | "business" | "operational" | "personal" | "financial" | "safety";
  authority_registry_ref: string;
  action_registry_ref: string;
  idempotency_contract: string;
  retry_contract: string;
  readback_contract: string;
  reconciliation_contract: string;
  enabled: number;
  proof_ttl_seconds: number;
  safe_fallback: string;
  disable_contract: string;
  rollback_contract: string;
  tenant_config_digest_sha256: string;
  credential_binding_digest_sha256: string;
  route_digest_sha256: string;
  artifact_digest_sha256: string;
  source_repository: string;
  source_commit: string;
  source_path: string;
  owner_user_id: string;
  approved_at: string;
}

export interface CapabilityProofFact {
  proof_id: string;
  tenant_id: string;
  capability_id: CapabilityId;
  proof_version: number;
  manifest_id: string;
  manifest_version: number;
  provider_key: string;
  provider_realm_ref: string;
  provider_realm_digest_sha256: string;
  verified_actions_json: string;
  verification_state: "verified" | "failed" | "unavailable" | "contradictory";
  provider_identity_verified: number;
  tenant_config_digest_sha256: string;
  credential_binding_digest_sha256: string;
  route_digest_sha256: string;
  artifact_digest_sha256: string;
  readback_digest_sha256: string;
  evidence_ref: string;
  issuer_ref: string;
  observed_at: string;
  expires_at: string;
  recorded_by_user_id: string;
}

export interface CapabilityReadinessProfile {
  profile_id: string;
  tenant_id: string;
  profile_key: ReadinessProfileKey;
  profile_version: number;
  profile_digest_sha256: string;
  capabilities_json: string;
  dependencies_json: string;
  source_repository: string;
  source_commit: string;
  source_path: string;
  owner_user_id: string;
  approved_at: string;
}

interface ProfileCapabilitySpec {
  capability_id: CapabilityId;
  required: boolean;
  ordinal: number;
}

interface ProfileDependencySpec {
  profile_key: Exclude<ReadinessProfileKey, "reference_journey">;
  minimum_version: number;
}

export interface CapabilityReadinessDataset {
  manifests: CapabilityManifest[];
  proofs: CapabilityProofFact[];
  profiles: CapabilityReadinessProfile[];
  runtime?: Partial<Record<CapabilityId, boolean>>;
  effect_runtime_ready?: boolean;
  current_realm_refs?: Partial<Record<CapabilityId, string | null>>;
}

export interface CapabilityReadinessItem {
  id: CapabilityId;
  required: boolean;
  state: "ready" | "blocked";
  last_proof_at: string | null;
  proof_expires_at: string | null;
  fallback: string | null;
  blockers: string[];
  manifest: null | {
    id: string;
    version: number;
    provider: string;
    realm: string;
    direction: CapabilityManifest["direction"];
    owner_user_id: string;
    source_repository: string;
    source_commit: string;
  };
}

export interface CapabilityReadinessEvaluation {
  profile: {
    key: ReadinessProfileKey;
    version: number | null;
    state: "ready" | "blocked";
    blockers: string[];
    dependencies: Array<{
      key: Exclude<ReadinessProfileKey, "reference_journey">;
      minimum_version: number;
      state: "ready" | "blocked";
    }>;
  };
  capabilities: CapabilityReadinessItem[];
  verdict: "ready" | "blocked";
}

export interface CapabilityReadinessReadModel extends CapabilityReadinessEvaluation {
  version: 1;
  tenant_id: string;
  read_model_generated_at: string;
  allowed_actions: readonly ["integrations.readiness.read"];
  configuration_mutations_available: false;
}

type ManifestAction = { name: string; enabled: boolean };

export function evaluateCapabilityReadiness(
  profileKey: ReadinessProfileKey,
  data: CapabilityReadinessDataset,
  now = new Date(),
): CapabilityReadinessEvaluation {
  const profileMemo = new Map<ReadinessProfileKey, ProfileEvaluation>();
  const evaluating = new Set<ReadinessProfileKey>();

  const evaluateProfile = (key: ReadinessProfileKey): ProfileEvaluation => {
    const memoized = profileMemo.get(key);
    if (memoized) return memoized;
    if (evaluating.has(key)) {
      return {
        key,
        version: null,
        blocked: true,
        blockers: ["profile_dependency_cycle"],
        requirements: new Map(),
        dependencies: [],
      };
    }
    evaluating.add(key);
    const selection = selectHead(
      data.profiles.filter((profile) => profile.profile_key === key),
      (profile) => profile.profile_version,
    );
    const blockers: string[] = [];
    const requirements = new Map<CapabilityId, boolean>();
    const dependencyItems: ProfileEvaluation["dependencies"] = [];
    if (selection.ambiguous) blockers.push("profile_head_ambiguous");
    if (!selection.value) blockers.push("profile_missing");

    if (selection.value) {
      const capabilitySpecs = parseProfileCapabilities(selection.value.capabilities_json);
      const dependencySpecs = parseProfileDependencies(selection.value.dependencies_json);
      if (!capabilitySpecs) blockers.push("profile_capabilities_invalid");
      if (!dependencySpecs) blockers.push("profile_dependencies_invalid");
      for (const row of capabilitySpecs ?? []) requirements.set(row.capability_id, row.required);
      for (const capability of PROFILE_REQUIREMENTS[key]) {
        if (requirements.get(capability) !== true)
          blockers.push(`required_capability_missing:${capability}`);
      }

      const expectedDependencies = PROFILE_DEPENDENCIES[key] as readonly ReadinessProfileKey[];
      for (const expected of expectedDependencies) {
        if (!dependencySpecs?.some((row) => row.profile_key === expected))
          blockers.push(`profile_dependency_missing:${expected}`);
      }
      for (const row of dependencySpecs ?? []) {
        if (!expectedDependencies.includes(row.profile_key)) {
          blockers.push(`profile_dependency_unexpected:${row.profile_key}`);
          continue;
        }
        const dependency = evaluateProfile(row.profile_key);
        const dependencyBlocked =
          dependency.blocked ||
          dependency.version === null ||
          dependency.version < row.minimum_version;
        if (dependency.version !== null && dependency.version < row.minimum_version)
          blockers.push(`profile_dependency_version:${row.profile_key}`);
        if (dependencyBlocked) blockers.push(`profile_dependency_blocked:${row.profile_key}`);
        for (const [capability, required] of dependency.requirements) {
          requirements.set(capability, required || requirements.get(capability) === true);
        }
        dependencyItems.push({
          key: row.profile_key,
          minimum_version: row.minimum_version,
          state: dependencyBlocked ? "blocked" : "ready",
        });
      }
    }

    const blockedRequiredCapability = [...requirements.entries()].some(
      ([capability, required]) =>
        required && evaluateCapability(capability, required, data, now).state === "blocked",
    );
    const result: ProfileEvaluation = {
      key,
      version: selection.value?.profile_version ?? null,
      blocked: blockers.length > 0 || blockedRequiredCapability,
      blockers: uniqueSorted(blockers),
      requirements,
      dependencies: dependencyItems,
    };
    evaluating.delete(key);
    profileMemo.set(key, result);
    return result;
  };

  const profile = evaluateProfile(profileKey);
  const capabilities = [...profile.requirements.entries()]
    .map(([capability, required]) => evaluateCapability(capability, required, data, now))
    .sort((left, right) => left.id.localeCompare(right.id));
  const blockedRequired = capabilities.some(
    (capability) => capability.required && capability.state === "blocked",
  );
  const verdict = !profile.blocked && !blockedRequired ? "ready" : "blocked";
  return {
    profile: {
      key: profile.key,
      version: profile.version,
      state: verdict,
      blockers: profile.blockers,
      dependencies: profile.dependencies,
    },
    capabilities,
    verdict,
  };
}

interface ProfileEvaluation {
  key: ReadinessProfileKey;
  version: number | null;
  blocked: boolean;
  blockers: string[];
  requirements: Map<CapabilityId, boolean>;
  dependencies: Array<{
    key: Exclude<ReadinessProfileKey, "reference_journey">;
    minimum_version: number;
    state: "ready" | "blocked";
  }>;
}

function evaluateCapability(
  capability: CapabilityId,
  required: boolean,
  data: CapabilityReadinessDataset,
  now: Date,
): CapabilityReadinessItem {
  const manifestSelection = selectHead(
    data.manifests.filter((manifest) => manifest.capability_id === capability),
    (manifest) => manifest.manifest_version,
  );
  const blockers: string[] = [];
  if (manifestSelection.ambiguous) blockers.push("manifest_head_ambiguous");
  const manifest = manifestSelection.value;
  if (!manifest) blockers.push("manifest_missing");
  let actions: ManifestAction[] = [];
  if (manifest) {
    if (manifest.enabled !== 1) blockers.push("manifest_disabled");
    if (!usableContract(manifest.idempotency_contract))
      blockers.push("idempotency_contract_missing");
    if (!usableContract(manifest.retry_contract)) blockers.push("retry_contract_missing");
    if (!usableContract(manifest.readback_contract)) blockers.push("readback_contract_missing");
    if (!usableContract(manifest.reconciliation_contract))
      blockers.push("reconciliation_contract_missing");
    if (!usableContract(manifest.rollback_contract)) blockers.push("rollback_missing");
    if (!usableContract(manifest.disable_contract)) blockers.push("disable_contract_missing");
    if (!usableContract(manifest.safe_fallback)) blockers.push("safe_fallback_missing");
    if (manifest.authority_registry_ref !== CAPABILITY_AUTHORITY_REGISTRY_REF)
      blockers.push("authority_registry_drift");
    if (manifest.action_registry_ref !== CAPABILITY_ACTION_REGISTRY_REF)
      blockers.push("action_registry_drift");
    const parsed = parseManifestActions(manifest.actions_json);
    if (!parsed.ok) {
      blockers.push(parsed.blocker);
    } else {
      actions = parsed.actions;
      const supported = CAPABILITY_ACTION_REGISTRY[capability];
      for (const action of actions) {
        if (!supported.includes(action.name)) blockers.push(`unsupported_action:${action.name}`);
      }
      for (const action of supported) {
        const declared = actions.find((candidate) => candidate.name === action);
        if (!declared) blockers.push(`required_action_missing:${action}`);
        else if (!declared.enabled) blockers.push(`required_action_disabled:${action}`);
      }
    }
    const authScopes = parseScopeNames(manifest.auth_scope_names_json);
    if (!authScopes) blockers.push("auth_scope_names_invalid");
    const requiresExternalEffect =
      manifest.direction !== "internal" &&
      manifest.direction !== "inbound" &&
      actions.some(
        (action) =>
          action.enabled && !action.name.endsWith(".read") && !action.name.endsWith(".readback"),
      );
    if (requiresExternalEffect && authScopes?.length === 0)
      blockers.push("auth_scope_names_missing");
    if (requiresExternalEffect && data.effect_runtime_ready !== true)
      blockers.push("effect_runtime_unready");
    const currentRealm = data.current_realm_refs?.[capability];
    if (currentRealm === null) blockers.push("provider_realm_unavailable");
    else if (currentRealm !== undefined && currentRealm !== manifest.provider_realm_ref)
      blockers.push("realm_drift");
    const liveSignalRequired = LIVE_RUNTIME_SIGNAL_CAPABILITIES.has(capability);
    const evidenceOnlyReadback = EVIDENCE_ONLY_RUNTIME_READBACK_CAPABILITIES.has(capability);
    if (liveSignalRequired && data.runtime?.[capability] !== true)
      blockers.push("runtime_unready");
    else if (!liveSignalRequired && !evidenceOnlyReadback)
      blockers.push("runtime_signal_classification_missing");
  }

  const proofSelection = selectHead(
    data.proofs.filter((proof) => proof.capability_id === capability),
    (proof) => proof.proof_version,
  );
  if (proofSelection.ambiguous) blockers.push("proof_head_ambiguous");
  const proof = proofSelection.value;
  if (!proof) blockers.push("proof_missing");
  if (manifest && proof) {
    if (
      proof.manifest_id !== manifest.manifest_id ||
      proof.manifest_version !== manifest.manifest_version
    )
      blockers.push("proof_manifest_drift");
    if (proof.provider_key !== manifest.provider_key) blockers.push("provider_drift");
    if (
      proof.provider_realm_ref !== manifest.provider_realm_ref ||
      proof.provider_realm_digest_sha256 !== manifest.provider_realm_digest_sha256
    )
      blockers.push("realm_drift");
    if (proof.tenant_config_digest_sha256 !== manifest.tenant_config_digest_sha256)
      blockers.push("config_digest_drift");
    if (proof.credential_binding_digest_sha256 !== manifest.credential_binding_digest_sha256)
      blockers.push("credential_binding_digest_drift");
    if (proof.route_digest_sha256 !== manifest.route_digest_sha256)
      blockers.push("route_digest_drift");
    if (proof.artifact_digest_sha256 !== manifest.artifact_digest_sha256)
      blockers.push("artifact_digest_drift");
    if (proof.verification_state !== "verified") blockers.push(`proof_${proof.verification_state}`);
    if (proof.provider_identity_verified !== 1) blockers.push("provider_identity_unverified");
    const observed = canonicalUtcMillis(proof.observed_at);
    const expires = canonicalUtcMillis(proof.expires_at);
    if (observed === null || expires === null) {
      blockers.push("proof_timestamp_invalid");
    } else {
      if (expires !== observed + manifest.proof_ttl_seconds * 1000)
        blockers.push("proof_ttl_drift");
      if (observed > now.getTime() + PROOF_MAX_CLOCK_SKEW_SECONDS * 1000)
        blockers.push("proof_observed_in_future");
      if (expires <= now.getTime()) blockers.push("proof_expired");
    }
    const verified = parseStringArray(proof.verified_actions_json);
    if (!verified) blockers.push("verified_actions_invalid");
    else {
      for (const action of actions.filter((candidate) => candidate.enabled)) {
        if (!verified.includes(action.name)) blockers.push(`action_proof_missing:${action.name}`);
      }
      for (const action of verified) {
        if (!CAPABILITY_ACTION_REGISTRY[capability].includes(action))
          blockers.push(`unsupported_action_proof:${action}`);
      }
    }
  }

  const finalBlockers = uniqueSorted(blockers);
  return {
    id: capability,
    required,
    state: finalBlockers.length === 0 ? "ready" : "blocked",
    last_proof_at: proof?.observed_at ?? null,
    proof_expires_at: proof?.expires_at ?? null,
    fallback: manifest?.safe_fallback ?? null,
    blockers: finalBlockers,
    manifest: manifest
      ? {
          id: manifest.manifest_id,
          version: manifest.manifest_version,
          provider: manifest.provider_key,
          realm: manifest.provider_realm_ref,
          direction: manifest.direction,
          owner_user_id: manifest.owner_user_id,
          source_repository: manifest.source_repository,
          source_commit: manifest.source_commit,
        }
      : null,
  };
}

export async function buildCapabilityReadinessReadModel(
  env: AppEnv,
  tenantId: string,
  profile: ReadinessProfileKey = "reference_journey",
  now = new Date(),
): Promise<CapabilityReadinessReadModel> {
  const [manifests, proofs, profiles, runtimeReadiness, quickBooksRealm, effectLedgerReady] = await Promise.all([
    rows<CapabilityManifest>(
      env,
      `SELECT candidate.*
         FROM capability_integration_manifests AS candidate
        WHERE candidate.tenant_id = ?
          AND candidate.manifest_version = (
            SELECT MAX(head.manifest_version)
              FROM capability_integration_manifests AS head
             WHERE head.tenant_id = candidate.tenant_id
               AND head.capability_id = candidate.capability_id
          )
        ORDER BY candidate.capability_id`,
      tenantId,
    ),
    rows<CapabilityProofFact>(
      env,
      `SELECT candidate.*
         FROM capability_proof_facts AS candidate
        WHERE candidate.tenant_id = ?
          AND candidate.proof_version = (
            SELECT MAX(head.proof_version)
              FROM capability_proof_facts AS head
             WHERE head.tenant_id = candidate.tenant_id
               AND head.capability_id = candidate.capability_id
          )
        ORDER BY candidate.capability_id`,
      tenantId,
    ),
    rows<CapabilityReadinessProfile>(
      env,
      `SELECT candidate.*
         FROM capability_readiness_profiles AS candidate
        WHERE candidate.tenant_id = ?
          AND candidate.profile_version = (
            SELECT MAX(head.profile_version)
              FROM capability_readiness_profiles AS head
             WHERE head.tenant_id = candidate.tenant_id
               AND head.profile_key = candidate.profile_key
          )
        ORDER BY candidate.profile_key`,
      tenantId,
    ),
    getReadiness(env as unknown as Env),
    quickBooksConnectedRealmId(env, tenantId).catch(() => null),
    String(env.EFFECT_RUNTIME_ENABLED ?? "") === "true"
      ? canonicalEffectLedgerSchemaReady(env)
      : Promise.resolve(false),
  ]);
  const evaluation = evaluateCapabilityReadiness(
    profile,
    {
      manifests,
      proofs,
      profiles,
      runtime: runtimeCapabilitySignals(runtimeReadiness, env, tenantId, quickBooksRealm),
      effect_runtime_ready: effectLedgerReady,
      current_realm_refs: { quickbooks: quickBooksRealm },
    },
    now,
  );
  return {
    version: 1,
    tenant_id: tenantId,
    read_model_generated_at: now.toISOString(),
    allowed_actions: ["integrations.readiness.read"],
    configuration_mutations_available: false,
    ...evaluation,
  };
}

function runtimeCapabilitySignals(
  report: ReadinessReport,
  env: AppEnv,
  tenantId: string,
  quickBooksRealm: string | null,
): Partial<Record<CapabilityId, boolean>> {
  const newo =
    report.checks.newo_enabled &&
    report.checks.newo_webhook_credentials &&
    report.checks.newo_api_authentication &&
    report.checks.newo_production_actor &&
    report.checks.newo_report_webhook_match &&
    report.checks.newo_configuration_drift &&
    report.checks.newo_queue_binding &&
    report.checks.newo_dlq_state &&
    report.checks.newo_jobnimbus_bridge &&
    report.checks.newo_booking_mode;
  return {
    email_delivery: report.checks.notification_configuration,
    magic_link: report.checks.app_bff_configuration && report.checks.notification_configuration,
    facet_association: facetLaunchConfigured(env, tenantId),
    quickbooks:
      quickBooksProviderApiBase(env) !== null &&
      quickBooksRealm !== null,
    measurement_ocr: report.checks.measurement_ocr_configuration,
    communications_rail: report.checks.notification_configuration,
    cloudflare_worker: true,
    pwa: report.checks.app_bff_configuration,
    d1: report.checks.d1 && report.checks.schema,
    r2: report.checks.raw_store_binding,
    queues: report.checks.queue_binding,
    newo,
    postiz: postizConfigured(env),
    public_estimator: report.checks.public_estimate_configuration,
  };
}

async function rows<T>(env: AppEnv, sql: string, tenantId: string): Promise<T[]> {
  const result = await env.DB.prepare(sql).bind(tenantId).all<T>();
  return result.results ?? [];
}

async function canonicalEffectLedgerSchemaReady(env: AppEnv): Promise<boolean> {
  if (!effectLedgerAvailable(env)) return false;
  const probes = [
    `SELECT effect_id, tenant_id, actor_type, actor_id, task_id, authority_ref, policy_ref,
            policy_version, aggregate_type, aggregate_id, aggregate_version, intent_id, action,
            request_hash, envelope_hash, provider, provider_account_ref, idempotency_key,
            deadline_at, lease_expires_at, preconditions_json, evidence_refs_json,
            expected_readback_json, retry_limit, compensation_plan_json, correlation_id,
            parent_effect_id, compensates_effect_id, state, attempt_count, provider_external_id,
            provider_response_hash, readback_hash, result_code, exception_ref, created_at, updated_at
       FROM external_effects LIMIT 0`,
    `SELECT attempt_id, effect_id, attempt_number, business_idempotency_key, request_hash, state,
            provider_external_id, provider_response_hash, readback_hash, result_code, started_at,
            ended_at
       FROM external_effect_attempts LIMIT 0`,
    `SELECT event_seq, effect_id, tenant_id, event_type, from_state, to_state, attempt_id,
            detail_code, evidence_hash, occurred_at
       FROM external_effect_events LIMIT 0`,
    `SELECT exception_id, effect_id, tenant_id, reason_code, expected_hash, observed_hash,
            evidence_hash, status, resolution_ref, created_at, resolved_at
       FROM external_effect_exceptions LIMIT 0`,
  ];
  try {
    await Promise.all(probes.map((sql) => env.DB.prepare(sql).bind().all()));
    return true;
  } catch {
    return false;
  }
}

function selectHead<T>(
  rows: readonly T[],
  version: (row: T) => number,
): { value: T | null; ambiguous: boolean } {
  if (rows.length === 0) return { value: null, ambiguous: false };
  const maximum = Math.max(...rows.map(version));
  const heads = rows.filter((row) => version(row) === maximum);
  return { value: heads[0] ?? null, ambiguous: heads.length !== 1 };
}

function parseProfileCapabilities(value: string): ProfileCapabilitySpec[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const capabilities: ProfileCapabilitySpec[] = [];
    const ids = new Set<CapabilityId>();
    const ordinals = new Set<number>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "capability_id,ordinal,required" ||
        typeof record.capability_id !== "string" ||
        !CAPABILITY_IDS.includes(record.capability_id as CapabilityId) ||
        typeof record.required !== "boolean" ||
        !Number.isInteger(record.ordinal) ||
        Number(record.ordinal) < 0 ||
        Number(record.ordinal) > 1000
      )
        return null;
      const capabilityId = record.capability_id as CapabilityId;
      const ordinal = Number(record.ordinal);
      if (ids.has(capabilityId) || ordinals.has(ordinal)) return null;
      ids.add(capabilityId);
      ordinals.add(ordinal);
      capabilities.push({ capability_id: capabilityId, required: record.required, ordinal });
    }
    return capabilities.sort(
      (left, right) =>
        left.ordinal - right.ordinal || left.capability_id.localeCompare(right.capability_id),
    );
  } catch {
    return null;
  }
}

function parseProfileDependencies(value: string): ProfileDependencySpec[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const dependencies: ProfileDependencySpec[] = [];
    const keys = new Set<ProfileDependencySpec["profile_key"]>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "minimum_version,profile_key" ||
        typeof record.profile_key !== "string" ||
        record.profile_key === "reference_journey" ||
        !READINESS_PROFILE_KEYS.includes(record.profile_key as ReadinessProfileKey) ||
        !Number.isInteger(record.minimum_version) ||
        Number(record.minimum_version) < 1 ||
        Number(record.minimum_version) > 1_000_000
      )
        return null;
      const profileKey = record.profile_key as ProfileDependencySpec["profile_key"];
      if (keys.has(profileKey)) return null;
      keys.add(profileKey);
      dependencies.push({
        profile_key: profileKey,
        minimum_version: Number(record.minimum_version),
      });
    }
    return dependencies.sort((left, right) => left.profile_key.localeCompare(right.profile_key));
  } catch {
    return null;
  }
}

function parseManifestActions(
  value: string,
): { ok: true; actions: ManifestAction[] } | { ok: false; blocker: string } {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0)
      return { ok: false, blocker: "actions_invalid" };
    const actions: ManifestAction[] = [];
    const names = new Set<string>();
    for (const item of parsed) {
      if (!item || typeof item !== "object" || Array.isArray(item))
        return { ok: false, blocker: "actions_invalid" };
      const record = item as Record<string, unknown>;
      if (
        Object.keys(record).sort().join(",") !== "enabled,name" ||
        typeof record.name !== "string" ||
        !validActionName(record.name) ||
        typeof record.enabled !== "boolean" ||
        names.has(record.name)
      )
        return { ok: false, blocker: "actions_invalid" };
      names.add(record.name);
      actions.push({ name: record.name, enabled: record.enabled });
    }
    return { ok: true, actions };
  } catch {
    return { ok: false, blocker: "actions_invalid" };
  }
}

function parseScopeNames(value: string): string[] | null {
  const scopes = parseStringArray(value);
  return scopes?.every((scope) => /^[a-z][a-z0-9._:-]{0,119}$/.test(scope)) ? scopes : null;
}

function parseStringArray(value: string): string[] | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim()))
      return null;
    const values = parsed as string[];
    return new Set(values).size === values.length ? values : null;
  } catch {
    return null;
  }
}

function validActionName(value: string): boolean {
  return /^[a-z][a-z0-9_.:-]{2,119}$/.test(value);
}

function canonicalUtcMillis(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? milliseconds : null;
}

function usableContract(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length >= 3 && !["none", "n/a", "na", "unavailable"].includes(normalized);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}
