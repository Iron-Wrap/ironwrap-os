-- 0118_capability_readiness.sql
-- Approved integration configuration and capability proof are evidence, not mutable settings.
-- Every correction is a new version/fact. Browser sessions receive a read projection only; this
-- migration intentionally creates no configuration command or provider-execution surface.

CREATE TABLE capability_integration_manifests (
  manifest_id TEXT PRIMARY KEY CHECK (
    length(manifest_id) BETWEEN 12 AND 160
    AND manifest_id GLOB '[A-Za-z0-9]*'
    AND manifest_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  capability_id TEXT NOT NULL CHECK (capability_id IN (
    'email_delivery', 'magic_link', 'facet_association', 'quickbooks',
    'measurement_ocr', 'supplier_rail', 'communications_rail',
    'cloudflare_worker', 'pwa', 'd1', 'r2', 'queues', 'backup_restore',
    'observability', 'newo', 'postiz', 'public_estimator'
  )),
  manifest_version INTEGER NOT NULL CHECK (manifest_version BETWEEN 1 AND 1000000),
  provider_key TEXT NOT NULL CHECK (
    length(provider_key) BETWEEN 2 AND 80
    AND provider_key NOT GLOB '*[^a-z0-9._-]*'
  ),
  provider_realm_ref TEXT NOT NULL CHECK (length(trim(provider_realm_ref)) BETWEEN 1 AND 200),
  provider_realm_digest_sha256 TEXT NOT NULL CHECK (
    length(provider_realm_digest_sha256) = 64
    AND provider_realm_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'bidirectional', 'internal')),
  actions_json TEXT NOT NULL CHECK (
    json_valid(actions_json)
    AND json_type(actions_json) = 'array'
    AND length(actions_json) BETWEEN 2 AND 12000
  ),
  auth_scope_names_json TEXT NOT NULL CHECK (
    json_valid(auth_scope_names_json)
    AND json_type(auth_scope_names_json) = 'array'
    AND length(auth_scope_names_json) BETWEEN 2 AND 8000
  ),
  data_class TEXT NOT NULL CHECK (data_class IN (
    'public', 'business', 'operational', 'personal', 'financial', 'safety'
  )),
  authority_registry_ref TEXT NOT NULL CHECK (length(trim(authority_registry_ref)) BETWEEN 3 AND 240),
  action_registry_ref TEXT NOT NULL CHECK (length(trim(action_registry_ref)) BETWEEN 3 AND 240),
  idempotency_contract TEXT NOT NULL CHECK (length(trim(idempotency_contract)) BETWEEN 3 AND 1000),
  retry_contract TEXT NOT NULL CHECK (length(trim(retry_contract)) BETWEEN 3 AND 1000),
  readback_contract TEXT NOT NULL CHECK (length(trim(readback_contract)) BETWEEN 3 AND 1000),
  reconciliation_contract TEXT NOT NULL CHECK (length(trim(reconciliation_contract)) BETWEEN 3 AND 1000),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  proof_ttl_seconds INTEGER NOT NULL CHECK (proof_ttl_seconds BETWEEN 60 AND 2592000),
  safe_fallback TEXT NOT NULL CHECK (length(trim(safe_fallback)) BETWEEN 3 AND 1000),
  disable_contract TEXT NOT NULL CHECK (length(trim(disable_contract)) BETWEEN 3 AND 1000),
  rollback_contract TEXT NOT NULL CHECK (length(trim(rollback_contract)) BETWEEN 3 AND 1000),
  tenant_config_digest_sha256 TEXT NOT NULL CHECK (
    length(tenant_config_digest_sha256) = 64
    AND tenant_config_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_binding_digest_sha256 TEXT NOT NULL CHECK (
    length(credential_binding_digest_sha256) = 64
    AND credential_binding_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  route_digest_sha256 TEXT NOT NULL CHECK (
    length(route_digest_sha256) = 64
    AND route_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_digest_sha256 TEXT NOT NULL CHECK (
    length(artifact_digest_sha256) = 64
    AND artifact_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_repository TEXT NOT NULL CHECK (length(trim(source_repository)) BETWEEN 3 AND 200),
  source_commit TEXT NOT NULL CHECK (
    length(source_commit) = 40
    AND source_commit NOT GLOB '*[^0-9a-f]*'
  ),
  source_path TEXT NOT NULL CHECK (length(trim(source_path)) BETWEEN 1 AND 300),
  owner_user_id TEXT NOT NULL,
  approved_at TEXT NOT NULL CHECK (length(approved_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, capability_id, manifest_version),
  UNIQUE (manifest_id, tenant_id, capability_id, manifest_version),
  FOREIGN KEY (owner_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_capability_manifests_tenant_head
  ON capability_integration_manifests (tenant_id, capability_id, manifest_version DESC);

CREATE TRIGGER capability_integration_manifests_validate_owner
BEFORE INSERT ON capability_integration_manifests BEGIN
  SELECT RAISE(ABORT, 'capability_manifest_owner_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.owner_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.access_role IN ('owner', 'ops')
  );
END;

CREATE TRIGGER capability_integration_manifests_append_only_update
BEFORE UPDATE ON capability_integration_manifests BEGIN
  SELECT RAISE(ABORT, 'capability_integration_manifests_append_only');
END;

CREATE TRIGGER capability_integration_manifests_append_only_delete
BEFORE DELETE ON capability_integration_manifests BEGIN
  SELECT RAISE(ABORT, 'capability_integration_manifests_retained');
END;

CREATE TABLE capability_proof_facts (
  proof_id TEXT PRIMARY KEY CHECK (
    length(proof_id) BETWEEN 12 AND 160
    AND proof_id GLOB '[A-Za-z0-9]*'
    AND proof_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  capability_id TEXT NOT NULL CHECK (capability_id IN (
    'email_delivery', 'magic_link', 'facet_association', 'quickbooks',
    'measurement_ocr', 'supplier_rail', 'communications_rail',
    'cloudflare_worker', 'pwa', 'd1', 'r2', 'queues', 'backup_restore',
    'observability', 'newo', 'postiz', 'public_estimator'
  )),
  proof_version INTEGER NOT NULL CHECK (proof_version BETWEEN 1 AND 1000000),
  manifest_id TEXT NOT NULL,
  manifest_version INTEGER NOT NULL CHECK (manifest_version BETWEEN 1 AND 1000000),
  provider_key TEXT NOT NULL CHECK (length(provider_key) BETWEEN 2 AND 80),
  provider_realm_ref TEXT NOT NULL CHECK (length(trim(provider_realm_ref)) BETWEEN 1 AND 200),
  provider_realm_digest_sha256 TEXT NOT NULL CHECK (
    length(provider_realm_digest_sha256) = 64
    AND provider_realm_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  verified_actions_json TEXT NOT NULL CHECK (
    json_valid(verified_actions_json)
    AND json_type(verified_actions_json) = 'array'
    AND length(verified_actions_json) BETWEEN 2 AND 12000
  ),
  verification_state TEXT NOT NULL CHECK (
    verification_state IN ('verified', 'failed', 'unavailable', 'contradictory')
  ),
  provider_identity_verified INTEGER NOT NULL CHECK (provider_identity_verified IN (0, 1)),
  tenant_config_digest_sha256 TEXT NOT NULL CHECK (
    length(tenant_config_digest_sha256) = 64
    AND tenant_config_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  credential_binding_digest_sha256 TEXT NOT NULL CHECK (
    length(credential_binding_digest_sha256) = 64
    AND credential_binding_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  route_digest_sha256 TEXT NOT NULL CHECK (
    length(route_digest_sha256) = 64
    AND route_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_digest_sha256 TEXT NOT NULL CHECK (
    length(artifact_digest_sha256) = 64
    AND artifact_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  readback_digest_sha256 TEXT NOT NULL CHECK (
    length(readback_digest_sha256) = 64
    AND readback_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) BETWEEN 3 AND 500),
  issuer_ref TEXT NOT NULL CHECK (length(trim(issuer_ref)) BETWEEN 3 AND 240),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40 AND expires_at > observed_at),
  recorded_by_user_id TEXT NOT NULL,
  UNIQUE (tenant_id, capability_id, proof_version),
  UNIQUE (proof_id, tenant_id, capability_id, proof_version),
  FOREIGN KEY (manifest_id, tenant_id, capability_id, manifest_version)
    REFERENCES capability_integration_manifests (
      manifest_id, tenant_id, capability_id, manifest_version
    ) ON DELETE RESTRICT,
  FOREIGN KEY (recorded_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_capability_proofs_tenant_head
  ON capability_proof_facts (tenant_id, capability_id, proof_version DESC);

CREATE TRIGGER capability_proof_facts_validate_actor
BEFORE INSERT ON capability_proof_facts BEGIN
  SELECT RAISE(ABORT, 'capability_proof_business_actor_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.recorded_by_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.access_role IN ('owner', 'ops')
  );
  SELECT RAISE(ABORT, 'capability_proof_manifest_binding_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM capability_integration_manifests AS manifest
    WHERE manifest.manifest_id = NEW.manifest_id
      AND manifest.tenant_id = NEW.tenant_id
      AND manifest.capability_id = NEW.capability_id
      AND manifest.manifest_version = NEW.manifest_version
      AND manifest.provider_key = NEW.provider_key
      AND manifest.provider_realm_ref = NEW.provider_realm_ref
  );
END;

CREATE TRIGGER capability_proof_facts_append_only_update
BEFORE UPDATE ON capability_proof_facts BEGIN
  SELECT RAISE(ABORT, 'capability_proof_facts_append_only');
END;

CREATE TRIGGER capability_proof_facts_append_only_delete
BEFORE DELETE ON capability_proof_facts BEGIN
  SELECT RAISE(ABORT, 'capability_proof_facts_retained');
END;

CREATE TABLE capability_readiness_profiles (
  profile_id TEXT PRIMARY KEY CHECK (
    length(profile_id) BETWEEN 12 AND 160
    AND profile_id GLOB '[A-Za-z0-9]*'
    AND profile_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  profile_key TEXT NOT NULL CHECK (profile_key IN (
    'core', 'commercial_closure', 'field_closure', 'accounting_closure',
    'reference_journey'
  )),
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 1000000),
  profile_digest_sha256 TEXT NOT NULL CHECK (
    length(profile_digest_sha256) = 64
    AND profile_digest_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  capabilities_json TEXT NOT NULL CHECK (
    json_valid(capabilities_json)
    AND json_type(capabilities_json) = 'array'
    AND length(capabilities_json) BETWEEN 2 AND 12000
  ),
  dependencies_json TEXT NOT NULL CHECK (
    json_valid(dependencies_json)
    AND json_type(dependencies_json) = 'array'
    AND length(dependencies_json) BETWEEN 2 AND 8000
  ),
  source_repository TEXT NOT NULL CHECK (length(trim(source_repository)) BETWEEN 3 AND 200),
  source_commit TEXT NOT NULL CHECK (
    length(source_commit) = 40
    AND source_commit NOT GLOB '*[^0-9a-f]*'
  ),
  source_path TEXT NOT NULL CHECK (length(trim(source_path)) BETWEEN 1 AND 300),
  owner_user_id TEXT NOT NULL,
  approved_at TEXT NOT NULL CHECK (length(approved_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, profile_key, profile_version),
  UNIQUE (profile_id, tenant_id),
  FOREIGN KEY (owner_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_capability_profiles_tenant_head
  ON capability_readiness_profiles (tenant_id, profile_key, profile_version DESC);

CREATE TRIGGER capability_readiness_profiles_validate_owner
BEFORE INSERT ON capability_readiness_profiles BEGIN
  SELECT RAISE(ABORT, 'capability_profile_owner_required')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users AS actor
    WHERE actor.user_id = NEW.owner_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.access_role IN ('owner', 'ops')
  );
END;

CREATE TRIGGER capability_readiness_profiles_append_only_update
BEFORE UPDATE ON capability_readiness_profiles BEGIN
  SELECT RAISE(ABORT, 'capability_readiness_profiles_append_only');
END;

CREATE TRIGGER capability_readiness_profiles_append_only_delete
BEFORE DELETE ON capability_readiness_profiles BEGIN
  SELECT RAISE(ABORT, 'capability_readiness_profiles_retained');
END;
