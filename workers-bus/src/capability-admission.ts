import type { AppEnv, AuthContext } from "./app-types.ts";
import {
  CAPABILITY_ACTION_REGISTRY,
  CAPABILITY_ACTION_REGISTRY_REF,
  CAPABILITY_AUTHORITY_REGISTRY_REF,
  CAPABILITY_IDS,
  EXTERNAL_EFFECT_CAPABILITIES,
  PROFILE_DEPENDENCIES,
  PROFILE_REQUIREMENTS,
  READINESS_PROFILE_KEYS,
  parseManifestActions,
  parseProfileCapabilities,
  parseProfileDependencies,
  parseScopeNames,
  usableContract,
  type CapabilityManifest,
  type CapabilityReadinessProfile,
  type CapabilityId,
  type ReadinessProfileKey,
} from "./capability-readiness.ts";

type AdmissionResult =
  | {
      status: 200 | 201;
      body: { id: string; version: number; replayed: boolean };
    }
  | { status: 400 | 403 | 409 | 502; body: { error: string } };

const MANIFEST_KEYS = [
  "manifest_id",
  "capability_id",
  "manifest_version",
  "expected_version",
  "provider_key",
  "provider_realm_ref",
  "provider_realm_digest_sha256",
  "direction",
  "actions",
  "auth_scope_names",
  "data_class",
  "idempotency_contract",
  "retry_contract",
  "readback_contract",
  "reconciliation_contract",
  "enabled",
  "proof_ttl_seconds",
  "safe_fallback",
  "disable_contract",
  "rollback_contract",
  "tenant_config_digest_sha256",
  "credential_binding_digest_sha256",
  "route_digest_sha256",
  "artifact_digest_sha256",
  "source_repository",
  "source_commit",
  "source_path",
] as const;

const PROFILE_KEYS = [
  "profile_id",
  "profile_key",
  "profile_version",
  "expected_version",
  "capabilities",
  "dependencies",
  "source_repository",
  "source_commit",
  "source_path",
] as const;

const MANIFEST_COLUMNS = [
  "manifest_id",
  "tenant_id",
  "capability_id",
  "manifest_version",
  "provider_key",
  "provider_realm_ref",
  "provider_realm_digest_sha256",
  "direction",
  "actions_json",
  "auth_scope_names_json",
  "data_class",
  "authority_registry_ref",
  "action_registry_ref",
  "idempotency_contract",
  "retry_contract",
  "readback_contract",
  "reconciliation_contract",
  "enabled",
  "proof_ttl_seconds",
  "safe_fallback",
  "disable_contract",
  "rollback_contract",
  "tenant_config_digest_sha256",
  "credential_binding_digest_sha256",
  "route_digest_sha256",
  "artifact_digest_sha256",
  "source_repository",
  "source_commit",
  "source_path",
  "owner_user_id",
  "approved_at",
] as const;

const PROFILE_COLUMNS = [
  "profile_id",
  "tenant_id",
  "profile_key",
  "profile_version",
  "profile_digest_sha256",
  "capabilities_json",
  "dependencies_json",
  "source_repository",
  "source_commit",
  "source_path",
  "owner_user_id",
  "approved_at",
] as const;

/** These are owner-approved declarations. No browser request can create a provider proof. */
export async function admitCapabilityManifest(
  env: AppEnv,
  auth: AuthContext,
  input: unknown,
  now = new Date(),
): Promise<AdmissionResult> {
  const actor = await currentApprover(env, auth);
  if (actor === "unavailable")
    return refusal("integration_admission_store_unavailable", 502);
  if (actor === null) return refusal("integration_approver_changed", 403);
  const parsed = parseManifest(
    input,
    auth.session.tenant_id,
    auth.session.user_id,
    now,
  );
  if (!parsed) return refusal("integration_manifest_invalid", 400);
  const { record, expectedVersion } = parsed;
  const values = MANIFEST_COLUMNS.map((column) => record[column]);
  const existing = await findRow<CapabilityManifest>(
    env,
    "capability_integration_manifests",
    "manifest_id",
    record.manifest_id,
    record.tenant_id,
  );
  if (existing && matches(existing, record, MANIFEST_COLUMNS))
    return accepted(record.manifest_id, record.manifest_version, true);
  if (existing) return refusal("integration_admission_id_conflict", 409);
  try {
    const result = await env.DB.prepare(
      conditionalInsert(
        "capability_integration_manifests",
        MANIFEST_COLUMNS,
        "capability_id",
        "manifest_version",
      ),
    )
      .bind(
        ...values,
        record.tenant_id,
        record.capability_id,
        expectedVersion,
        record.owner_user_id,
        record.tenant_id,
        actor,
      )
      .run();
    if (result.meta.changes === 1)
      return accepted(record.manifest_id, record.manifest_version, false);
  } catch {
    // A competing insert can win the version or ID constraint. Read the durable result before
    // calling it a failure; unrelated D1 faults remain unavailable below.
  }
  return settleFailedInsert(
    env,
    auth,
    "capability_integration_manifests",
    "manifest_id",
    record,
    MANIFEST_COLUMNS,
    "capability_id",
    "manifest_version",
    expectedVersion,
  );
}

export async function admitCapabilityProfile(
  env: AppEnv,
  auth: AuthContext,
  input: unknown,
  now = new Date(),
): Promise<AdmissionResult> {
  const actor = await currentApprover(env, auth);
  if (actor === "unavailable")
    return refusal("integration_admission_store_unavailable", 502);
  if (actor === null) return refusal("integration_approver_changed", 403);
  const parsed = await parseProfile(
    input,
    auth.session.tenant_id,
    auth.session.user_id,
    now,
  );
  if (!parsed) return refusal("integration_profile_invalid", 400);
  const { record, expectedVersion } = parsed;
  const values = PROFILE_COLUMNS.map((column) => record[column]);
  const existing = await findRow<CapabilityReadinessProfile>(
    env,
    "capability_readiness_profiles",
    "profile_id",
    record.profile_id,
    record.tenant_id,
  );
  if (existing && matches(existing, record, PROFILE_COLUMNS))
    return accepted(record.profile_id, record.profile_version, true);
  if (existing) return refusal("integration_admission_id_conflict", 409);
  try {
    const result = await env.DB.prepare(
      conditionalInsert(
        "capability_readiness_profiles",
        PROFILE_COLUMNS,
        "profile_key",
        "profile_version",
      ),
    )
      .bind(
        ...values,
        record.tenant_id,
        record.profile_key,
        expectedVersion,
        record.owner_user_id,
        record.tenant_id,
        actor,
      )
      .run();
    if (result.meta.changes === 1)
      return accepted(record.profile_id, record.profile_version, false);
  } catch {
    // As for manifests, resolve an uncertain insert from the durable row.
  }
  return settleFailedInsert(
    env,
    auth,
    "capability_readiness_profiles",
    "profile_id",
    record,
    PROFILE_COLUMNS,
    "profile_key",
    "profile_version",
    expectedVersion,
  );
}

function conditionalInsert(
  table: string,
  columns: readonly string[],
  scope: string,
  version: string,
): string {
  return (
    "INSERT INTO " +
    table +
    " (" +
    columns.join(", ") +
    ") SELECT " +
    columns.map(() => "?").join(", ") +
    " WHERE (SELECT COALESCE(MAX(" +
    version +
    "), 0) FROM " +
    table +
    " WHERE tenant_id = ? AND " +
    scope +
    " = ?) = ?" +
    " AND EXISTS (SELECT 1 FROM app_users WHERE user_id = ? AND tenant_id = ?" +
    " AND active = 1 AND access_role = ?)"
  );
}

async function settleFailedInsert<T extends object>(
  env: AppEnv,
  auth: AuthContext,
  table: string,
  idColumn: string,
  record: T,
  columns: readonly (keyof T & string)[],
  scope: keyof T & string,
  version: string,
  expectedVersion: number,
): Promise<AdmissionResult> {
  try {
    const id = String(record[idColumn as keyof T]);
    const durable = await findRow<T>(
      env,
      table,
      idColumn,
      id,
      auth.session.tenant_id,
    );
    if (durable && matches(durable, record, columns))
      return accepted(id, Number(record[version as keyof T]), true);
    if (durable) return refusal("integration_admission_id_conflict", 409);
    const approver = await currentApprover(env, auth);
    if (approver === "unavailable")
      return refusal("integration_admission_store_unavailable", 502);
    if (approver === null) return refusal("integration_approver_changed", 403);
    // IDs are globally unique even though replay is tenant-scoped. Report a stable, generic
    // conflict without exposing which other tenant owns a colliding ID.
    const occupiedId = await env.DB.prepare(
      "SELECT 1 AS present FROM " +
        table +
        " WHERE " +
        idColumn +
        " = ? LIMIT 1",
    )
      .bind(id)
      .first<{ present: number }>();
    if (occupiedId) return refusal("integration_admission_id_conflict", 409);
    const head = await env.DB.prepare(
      "SELECT COALESCE(MAX(" +
        version +
        "), 0) AS version FROM " +
        table +
        " WHERE tenant_id = ? AND " +
        scope +
        " = ?",
    )
      .bind(auth.session.tenant_id, record[scope])
      .first<{ version: number }>();
    if (head?.version !== expectedVersion)
      return refusal("integration_admission_version_conflict", 409);
  } catch {
    return refusal("integration_admission_store_unavailable", 502);
  }
  return refusal("integration_admission_store_unavailable", 502);
}

async function currentApprover(
  env: AppEnv,
  auth: AuthContext,
): Promise<"owner" | "ops" | "unavailable" | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT access_role AS role FROM app_users" +
        " WHERE tenant_id = ? AND user_id = ? AND active = 1",
    )
      .bind(auth.session.tenant_id, auth.session.user_id)
      .first<{ role: string }>();
    return row &&
      row.role === auth.session.role &&
      (row.role === "owner" || row.role === "ops")
      ? row.role
      : null;
  } catch {
    return "unavailable";
  }
}

function parseManifest(
  input: unknown,
  tenantId: string,
  ownerId: string,
  now: Date,
): { record: CapabilityManifest; expectedVersion: number } | null {
  if (!exactObject(input, MANIFEST_KEYS)) return null;
  const capabilityId = input.capability_id;
  if (
    typeof capabilityId !== "string" ||
    !CAPABILITY_IDS.includes(capabilityId as CapabilityId)
  )
    return null;
  const capability = capabilityId as CapabilityId;
  const version = input.manifest_version;
  const expectedVersion = input.expected_version;
  if (!versionPair(version, expectedVersion)) return null;
  if (
    typeof input.manifest_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{11,159}$/.test(input.manifest_id)
  )
    return null;
  if (
    typeof input.provider_key !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{1,79}$/.test(input.provider_key)
  )
    return null;
  if (!plainText(input.provider_realm_ref, 1, 200)) return null;
  const direction = input.direction;
  if (
    typeof direction !== "string" ||
    !["inbound", "outbound", "bidirectional", "internal"].includes(direction)
  )
    return null;
  if (
    EXTERNAL_EFFECT_CAPABILITIES.has(capability) &&
    direction !== "outbound" &&
    direction !== "bidirectional"
  )
    return null;
  const dataClass = input.data_class;
  if (
    typeof dataClass !== "string" ||
    ![
      "public",
      "business",
      "operational",
      "personal",
      "financial",
      "safety",
    ].includes(dataClass)
  )
    return null;
  const actionsJson = JSON.stringify(input.actions);
  const actions = parseManifestActions(actionsJson);
  if (
    !actions.ok ||
    actions.actions.length !== CAPABILITY_ACTION_REGISTRY[capability].length
  )
    return null;
  if (
    actions.actions.some(
      (item) => !CAPABILITY_ACTION_REGISTRY[capability].includes(item.name),
    )
  )
    return null;
  const scopesJson = JSON.stringify(input.auth_scope_names);
  const scopes = parseScopeNames(scopesJson);
  if (!scopes) return null;
  const canonicalScopesJson = JSON.stringify([...scopes].sort());
  if (canonicalScopesJson.length > 8_000) return null;
  if (EXTERNAL_EFFECT_CAPABILITIES.has(capability) && scopes.length === 0)
    return null;
  if (
    direction !== "internal" &&
    direction !== "inbound" &&
    actions.actions.some(
      (action) =>
        action.enabled &&
        !action.name.endsWith(".read") &&
        !action.name.endsWith(".readback"),
    ) &&
    scopes.length === 0
  )
    return null;
  const contractFields = [
    "idempotency_contract",
    "retry_contract",
    "readback_contract",
    "reconciliation_contract",
    "safe_fallback",
    "disable_contract",
    "rollback_contract",
  ] as const;
  if (
    contractFields.some(
      (field) =>
        !plainText(input[field], 3, 1000) ||
        !usableContract(input[field] as string),
    )
  )
    return null;
  const digests = [
    "provider_realm_digest_sha256",
    "tenant_config_digest_sha256",
    "credential_binding_digest_sha256",
    "route_digest_sha256",
    "artifact_digest_sha256",
  ] as const;
  if (digests.some((field) => !digest(input[field]))) return null;
  if (typeof input.enabled !== "boolean") return null;
  if (!positiveInteger(input.proof_ttl_seconds, 60, 2_592_000)) return null;
  if (!source(input)) return null;
  const record: CapabilityManifest = {
    manifest_id: input.manifest_id as string,
    tenant_id: tenantId,
    capability_id: capability,
    manifest_version: version as number,
    provider_key: input.provider_key as string,
    provider_realm_ref: input.provider_realm_ref as string,
    provider_realm_digest_sha256: input.provider_realm_digest_sha256 as string,
    direction: direction as CapabilityManifest["direction"],
    actions_json: JSON.stringify(
      CAPABILITY_ACTION_REGISTRY[capability].map((name) =>
        actions.actions.find((action) => action.name === name),
      ),
    ),
    auth_scope_names_json: canonicalScopesJson,
    data_class: dataClass as CapabilityManifest["data_class"],
    authority_registry_ref: CAPABILITY_AUTHORITY_REGISTRY_REF,
    action_registry_ref: CAPABILITY_ACTION_REGISTRY_REF,
    idempotency_contract: input.idempotency_contract as string,
    retry_contract: input.retry_contract as string,
    readback_contract: input.readback_contract as string,
    reconciliation_contract: input.reconciliation_contract as string,
    enabled: input.enabled ? 1 : 0,
    proof_ttl_seconds: input.proof_ttl_seconds as number,
    safe_fallback: input.safe_fallback as string,
    disable_contract: input.disable_contract as string,
    rollback_contract: input.rollback_contract as string,
    tenant_config_digest_sha256: input.tenant_config_digest_sha256 as string,
    credential_binding_digest_sha256:
      input.credential_binding_digest_sha256 as string,
    route_digest_sha256: input.route_digest_sha256 as string,
    artifact_digest_sha256: input.artifact_digest_sha256 as string,
    source_repository: input.source_repository as string,
    source_commit: input.source_commit as string,
    source_path: input.source_path as string,
    owner_user_id: ownerId,
    approved_at: now.toISOString(),
  };
  return { record, expectedVersion: expectedVersion as number };
}

async function parseProfile(
  input: unknown,
  tenantId: string,
  ownerId: string,
  now: Date,
): Promise<{
  record: CapabilityReadinessProfile;
  expectedVersion: number;
} | null> {
  if (!exactObject(input, PROFILE_KEYS)) return null;
  const key = input.profile_key;
  if (
    typeof key !== "string" ||
    !READINESS_PROFILE_KEYS.includes(key as ReadinessProfileKey)
  )
    return null;
  const profileKey = key as ReadinessProfileKey;
  const version = input.profile_version;
  const expectedVersion = input.expected_version;
  if (!versionPair(version, expectedVersion)) return null;
  if (
    typeof input.profile_id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{11,159}$/.test(input.profile_id)
  )
    return null;
  const capabilities = parseProfileCapabilities(
    JSON.stringify(input.capabilities),
  );
  const dependencies = parseProfileDependencies(
    JSON.stringify(input.dependencies),
  );
  if (!capabilities || !dependencies) return null;
  if (
    PROFILE_REQUIREMENTS[profileKey].some(
      (required) =>
        capabilities.find((item) => item.capability_id === required)
          ?.required !== true,
    )
  )
    return null;
  const requiredDependencies = PROFILE_DEPENDENCIES[profileKey];
  if (
    dependencies.length !== requiredDependencies.length ||
    dependencies.some(
      (item) => !requiredDependencies.includes(item.profile_key),
    )
  )
    return null;
  if (!source(input)) return null;
  const capabilitiesJson = JSON.stringify(capabilities);
  const dependenciesJson = JSON.stringify(dependencies);
  const profileDigest = await sha256Hex(
    JSON.stringify({
      profile_key: profileKey,
      capabilities: capabilitiesJson,
      dependencies: dependenciesJson,
      source_repository: input.source_repository,
      source_commit: input.source_commit,
      source_path: input.source_path,
    }),
  );
  const record: CapabilityReadinessProfile = {
    profile_id: input.profile_id as string,
    tenant_id: tenantId,
    profile_key: profileKey,
    profile_version: version as number,
    profile_digest_sha256: profileDigest,
    capabilities_json: capabilitiesJson,
    dependencies_json: dependenciesJson,
    source_repository: input.source_repository as string,
    source_commit: input.source_commit as string,
    source_path: input.source_path as string,
    owner_user_id: ownerId,
    approved_at: now.toISOString(),
  };
  return { record, expectedVersion: expectedVersion as number };
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    Object.keys(value).every((key) => keys.includes(key))
  );
}

function wellFormedUnicode(value: string): boolean {
  for (const character of value) {
    if (
      character.length === 1 &&
      character.charCodeAt(0) >= 0xd800 &&
      character.charCodeAt(0) <= 0xdfff
    )
      return false;
  }
  return true;
}

function plainText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string" || !wellFormedUnicode(value)) return false;
  return (
    [...value.trim()].length >= min &&
    [...value].length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function positiveInteger(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function versionPair(version: unknown, expected: unknown): boolean {
  return (
    positiveInteger(version, 1, 1_000_000) &&
    positiveInteger(expected, 0, 999_999) &&
    version === expected + 1
  );
}

function source(value: Record<string, unknown>): boolean {
  return (
    typeof value.source_repository === "string" &&
    value.source_repository === "Iron-Wrap/ironwrap-os" &&
    typeof value.source_commit === "string" &&
    /^[0-9a-f]{40}$/u.test(value.source_commit) &&
    plainText(value.source_path, 1, 300) &&
    /^(workers-bus|config|mcp)\//u.test(value.source_path) &&
    value.source_path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    !value.source_path.includes("\\")
  );
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digestBytes = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digestBytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function findRow<T>(
  env: AppEnv,
  table: string,
  idColumn: string,
  id: string,
  tenantId: string,
): Promise<T | null> {
  return env.DB.prepare(
    "SELECT * FROM " + table + " WHERE " + idColumn + " = ? AND tenant_id = ?",
  )
    .bind(id, tenantId)
    .first<T>();
}

function matches<T extends object>(
  actual: T,
  expected: T,
  columns: readonly (keyof T & string)[],
): boolean {
  return columns
    .filter((column) => column !== "approved_at")
    .every((column) => actual[column] === expected[column]);
}

function accepted(
  id: string,
  version: number,
  replayed: boolean,
): AdmissionResult {
  return { status: replayed ? 200 : 201, body: { id, version, replayed } };
}

function refusal(
  error: string,
  status: 400 | 403 | 409 | 502,
): AdmissionResult {
  return { status, body: { error } };
}
