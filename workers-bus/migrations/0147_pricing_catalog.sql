-- Owned pricing authority. Creating a revision is not approval; only an explicit
-- human activation receipt advances the tenant head. Imports pin that receipt.
CREATE TABLE pricing_catalog_revisions (
  revision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  policy_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL CHECK (policy_revision BETWEEN 1 AND 9007199254740991),
  currency TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB)) <= 65536),
  snapshot_sha256 TEXT NOT NULL CHECK (length(snapshot_sha256)=64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'),
  effective_at TEXT NOT NULL CHECK (length(effective_at)=24),
  expires_at TEXT NOT NULL CHECK (length(expires_at)=24 AND expires_at >= effective_at),
  origin TEXT NOT NULL CHECK (origin IN ('manual','environment')),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner','ops')),
  actor_email TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (length(command_fingerprint)=64),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash)=64),
  created_at TEXT NOT NULL,
  UNIQUE (revision_id, tenant_id),
  UNIQUE (tenant_id, policy_id, policy_revision),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (actor_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);
CREATE TABLE pricing_catalog_heads (
  tenant_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  activation_id TEXT,
  CHECK ((version=0 AND activation_id IS NULL) OR (version>0 AND activation_id IS NOT NULL))
);
CREATE TABLE pricing_catalog_activations (
  activation_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version>0),
  prior_activation_id TEXT,
  reviewed_sha256 TEXT NOT NULL CHECK (length(reviewed_sha256)=64 AND reviewed_sha256 NOT GLOB '*[^0-9a-f]*'),
  actor_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner','ops')),
  actor_email TEXT NOT NULL,
  command_fingerprint TEXT NOT NULL CHECK (length(command_fingerprint)=64),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash)=64),
  approved_at TEXT NOT NULL,
  UNIQUE (activation_id, tenant_id),
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (revision_id, tenant_id) REFERENCES pricing_catalog_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_activation_id, tenant_id) REFERENCES pricing_catalog_activations(activation_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);
CREATE TABLE estimator_pricing_catalog_pins (
  estimator_revision_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL,
  priced_at TEXT NOT NULL,
  FOREIGN KEY (estimator_revision_id, tenant_id) REFERENCES estimator_evidence_revisions(estimator_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, tenant_id) REFERENCES pricing_catalog_revisions(revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (activation_id, tenant_id) REFERENCES pricing_catalog_activations(activation_id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX idx_pricing_catalog_history ON pricing_catalog_revisions(tenant_id, created_at DESC, revision_id);
CREATE INDEX idx_pricing_catalog_activations ON pricing_catalog_activations(tenant_id, version DESC);
CREATE INDEX idx_estimator_pricing_catalog_pins ON estimator_pricing_catalog_pins(tenant_id, revision_id, activation_id);

CREATE TRIGGER pricing_catalog_revision_guard BEFORE INSERT ON pricing_catalog_revisions BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_actor_forbidden') WHERE NOT EXISTS (
    SELECT 1 FROM app_users u WHERE u.user_id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.active=1
      AND COALESCE(u.access_role,u.role)=NEW.actor_role AND u.email_normalized=NEW.actor_email AND NEW.actor_role IN ('owner','ops'));
  SELECT RAISE(ABORT,'pricing_catalog_snapshot_invalid') WHERE
    json_extract(NEW.snapshot_json,'$.approvedPolicy.tenantId') IS NOT NEW.tenant_id OR
    json_extract(NEW.snapshot_json,'$.approvedPolicy.policyId') IS NOT NEW.policy_id OR
    json_extract(NEW.snapshot_json,'$.approvedPolicy.revision') IS NOT NEW.policy_revision OR
    json_extract(NEW.snapshot_json,'$.approvedPolicy.effectiveAt') IS NOT NEW.effective_at OR
    json_extract(NEW.snapshot_json,'$.approvedPolicy.expiresAt') IS NOT NEW.expires_at OR
    json_extract(NEW.snapshot_json,'$.currency') IS NOT NEW.currency;
END;
CREATE TRIGGER pricing_catalog_revision_no_replace BEFORE INSERT ON pricing_catalog_revisions BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_immutable') WHERE EXISTS (SELECT 1 FROM pricing_catalog_revisions
    WHERE revision_id=NEW.revision_id OR (tenant_id=NEW.tenant_id AND policy_id=NEW.policy_id AND policy_revision=NEW.policy_revision)
      OR (tenant_id=NEW.tenant_id AND idempotency_key_hash=NEW.idempotency_key_hash));
END;
CREATE TRIGGER pricing_catalog_revision_no_update BEFORE UPDATE ON pricing_catalog_revisions BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
CREATE TRIGGER pricing_catalog_revision_no_delete BEFORE DELETE ON pricing_catalog_revisions BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
CREATE TRIGGER pricing_catalog_head_insert_guard BEFORE INSERT ON pricing_catalog_heads BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_head_invalid') WHERE NEW.version!=0 OR NEW.activation_id IS NOT NULL;
  SELECT RAISE(ABORT,'pricing_catalog_head_immutable') WHERE EXISTS (SELECT 1 FROM pricing_catalog_heads WHERE tenant_id=NEW.tenant_id);
END;
CREATE TRIGGER pricing_catalog_head_update_guard BEFORE UPDATE ON pricing_catalog_heads BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_head_conflict') WHERE NEW.tenant_id!=OLD.tenant_id OR NEW.version!=OLD.version+1 OR NOT EXISTS (
    SELECT 1 FROM pricing_catalog_activations a WHERE a.tenant_id=NEW.tenant_id AND a.activation_id=NEW.activation_id
      AND a.version=NEW.version AND a.prior_activation_id IS OLD.activation_id);
END;
CREATE TRIGGER pricing_catalog_head_no_delete BEFORE DELETE ON pricing_catalog_heads BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
CREATE TRIGGER pricing_catalog_activation_guard BEFORE INSERT ON pricing_catalog_activations BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_actor_forbidden') WHERE NOT EXISTS (
    SELECT 1 FROM app_users u WHERE u.user_id=NEW.actor_id AND u.tenant_id=NEW.tenant_id AND u.active=1
      AND COALESCE(u.access_role,u.role)=NEW.actor_role AND u.email_normalized=NEW.actor_email AND NEW.actor_role IN ('owner','ops'));
  SELECT RAISE(ABORT,'pricing_catalog_head_conflict') WHERE NOT EXISTS (
    SELECT 1 FROM pricing_catalog_heads h WHERE h.tenant_id=NEW.tenant_id
      AND NEW.version=h.version+1 AND NEW.prior_activation_id IS h.activation_id);
  SELECT RAISE(ABORT,'pricing_catalog_review_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM pricing_catalog_revisions r WHERE r.tenant_id=NEW.tenant_id AND r.revision_id=NEW.revision_id
      AND r.snapshot_sha256=NEW.reviewed_sha256 AND NEW.approved_at>=r.created_at
      AND NEW.approved_at BETWEEN r.effective_at AND r.expires_at);
END;
CREATE TRIGGER pricing_catalog_activation_project AFTER INSERT ON pricing_catalog_activations BEGIN
  UPDATE pricing_catalog_heads SET version=NEW.version,activation_id=NEW.activation_id WHERE tenant_id=NEW.tenant_id;
END;
CREATE TRIGGER pricing_catalog_activation_no_replace BEFORE INSERT ON pricing_catalog_activations BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_immutable') WHERE EXISTS (SELECT 1 FROM pricing_catalog_activations
    WHERE activation_id=NEW.activation_id OR (tenant_id=NEW.tenant_id AND version=NEW.version)
      OR (tenant_id=NEW.tenant_id AND idempotency_key_hash=NEW.idempotency_key_hash));
END;
CREATE TRIGGER pricing_catalog_activation_no_update BEFORE UPDATE ON pricing_catalog_activations BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
CREATE TRIGGER pricing_catalog_activation_no_delete BEFORE DELETE ON pricing_catalog_activations BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;

-- Only a new import checks the active head. Saved imports never depend on the
-- current head or current clock and cannot silently acquire new pricing.
CREATE TRIGGER estimator_pricing_catalog_import_guard BEFORE INSERT ON estimator_evidence_revisions
WHEN json_extract(NEW.payload_json,'$.pricing_authority.catalog_revision_id') IS NOT NULL BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_import_drift') WHERE NOT EXISTS (
    SELECT 1 FROM pricing_catalog_heads h JOIN pricing_catalog_activations a ON a.activation_id=h.activation_id AND a.tenant_id=h.tenant_id
      JOIN pricing_catalog_revisions r ON r.revision_id=a.revision_id AND r.tenant_id=a.tenant_id
    WHERE h.tenant_id=NEW.tenant_id AND h.version=json_extract(NEW.payload_json,'$.pricing_authority.catalog_head_version')
      AND a.activation_id=json_extract(NEW.payload_json,'$.pricing_authority.catalog_activation_id')
      AND r.revision_id=json_extract(NEW.payload_json,'$.pricing_authority.catalog_revision_id')
      AND r.snapshot_json=json_extract(NEW.payload_json,'$.pricing_authority.pricing_policy_snapshot_json')
      AND r.snapshot_sha256=json_extract(NEW.payload_json,'$.pricing_authority.pricing_policy_snapshot_sha256')
      AND NEW.created_at=json_extract(NEW.payload_json,'$.pricing_authority.catalog_priced_at')
      AND NEW.created_at BETWEEN r.effective_at AND r.expires_at AND a.approved_at<=NEW.created_at);
END;
CREATE TRIGGER estimator_pricing_catalog_import_pin AFTER INSERT ON estimator_evidence_revisions
WHEN json_extract(NEW.payload_json,'$.pricing_authority.catalog_revision_id') IS NOT NULL BEGIN
  INSERT INTO estimator_pricing_catalog_pins VALUES (NEW.estimator_revision_id,NEW.tenant_id,
    json_extract(NEW.payload_json,'$.pricing_authority.catalog_revision_id'),
    json_extract(NEW.payload_json,'$.pricing_authority.catalog_activation_id'),
    json_extract(NEW.payload_json,'$.pricing_authority.pricing_policy_snapshot_sha256'),NEW.created_at);
END;
CREATE TRIGGER estimator_pricing_catalog_pin_guard BEFORE INSERT ON estimator_pricing_catalog_pins BEGIN
  SELECT RAISE(ABORT,'pricing_catalog_pin_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM estimator_evidence_revisions e JOIN pricing_catalog_activations a ON a.tenant_id=e.tenant_id
      JOIN pricing_catalog_revisions r ON r.revision_id=a.revision_id AND r.tenant_id=a.tenant_id
    WHERE e.estimator_revision_id=NEW.estimator_revision_id AND e.tenant_id=NEW.tenant_id
      AND a.activation_id=NEW.activation_id AND r.revision_id=NEW.revision_id AND r.snapshot_sha256=NEW.snapshot_sha256
      AND NEW.priced_at=e.created_at AND r.snapshot_json=json_extract(e.payload_json,'$.pricing_authority.pricing_policy_snapshot_json')
      AND NEW.revision_id=json_extract(e.payload_json,'$.pricing_authority.catalog_revision_id')
      AND NEW.activation_id=json_extract(e.payload_json,'$.pricing_authority.catalog_activation_id'));
  SELECT RAISE(ABORT,'pricing_catalog_immutable') WHERE EXISTS (SELECT 1 FROM estimator_pricing_catalog_pins WHERE estimator_revision_id=NEW.estimator_revision_id);
END;
CREATE TRIGGER estimator_pricing_catalog_pin_no_update BEFORE UPDATE ON estimator_pricing_catalog_pins BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
CREATE TRIGGER estimator_pricing_catalog_pin_no_delete BEFORE DELETE ON estimator_pricing_catalog_pins BEGIN SELECT RAISE(ABORT,'pricing_catalog_immutable'); END;
