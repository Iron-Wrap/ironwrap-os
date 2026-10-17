-- The provenance receipt remains immutable. Privacy decisions live beside it so
-- restored R2 bytes stay blocked while the current D1 disposition survives.
-- An older D1 restore can lose this row; external anti-rollback is a release gate.
CREATE TABLE evidence_upload_holds (
  hold_id TEXT PRIMARY KEY CHECK (length(hold_id) BETWEEN 8 AND 120),
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES evidence_upload_receipts(receipt_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  released_by TEXT,
  release_reason TEXT,
  released_at TEXT,
  CHECK ((active = 1 AND released_by IS NULL AND release_reason IS NULL AND released_at IS NULL)
    OR (active = 0 AND released_by IS NOT NULL AND length(release_reason) BETWEEN 8 AND 500 AND released_at IS NOT NULL))
);
CREATE INDEX evidence_upload_active_holds ON evidence_upload_holds(tenant_id, receipt_id, active);
CREATE TRIGGER evidence_upload_hold_insert_guard BEFORE INSERT ON evidence_upload_holds
WHEN NOT EXISTS (SELECT 1 FROM evidence_upload_receipts WHERE receipt_id = NEW.receipt_id AND tenant_id = NEW.tenant_id)
  OR EXISTS (SELECT 1 FROM evidence_upload_dispositions WHERE receipt_id = NEW.receipt_id AND state != 'failed')
BEGIN SELECT RAISE(ABORT, 'evidence_hold_scope_or_state_invalid'); END;
CREATE TRIGGER evidence_upload_hold_release_guard BEFORE UPDATE ON evidence_upload_holds
WHEN OLD.active != 1 OR NEW.active != 0 OR NEW.hold_id != OLD.hold_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.receipt_id != OLD.receipt_id OR NEW.reason != OLD.reason OR NEW.created_by != OLD.created_by
  OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'evidence_hold_release_invalid'); END;
CREATE TRIGGER evidence_upload_hold_immutable_delete BEFORE DELETE ON evidence_upload_holds
BEGIN SELECT RAISE(ABORT, 'evidence_hold_immutable'); END;

CREATE TABLE evidence_upload_dispositions (
  receipt_id TEXT PRIMARY KEY REFERENCES evidence_upload_receipts(receipt_id) ON DELETE RESTRICT,
  tenant_id TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE CHECK (length(decision_id) BETWEEN 8 AND 120),
  basis TEXT NOT NULL CHECK (basis IN ('subject_request', 'approved_retention', 'manual_correction')),
  authority_ref TEXT NOT NULL CHECK (length(authority_ref) BETWEEN 8 AND 200),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 3 AND 120),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 8 AND 500),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  last_actor_user_id TEXT NOT NULL,
  last_transition_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('destroying', 'failed', 'destroyed')),
  failure_code TEXT,
  verified_at TEXT,
  reappearance_detected_at TEXT,
  reappearance_reverified_at TEXT,
  CHECK ((state = 'destroying' AND failure_code IS NULL AND verified_at IS NULL)
    OR (state = 'failed' AND failure_code IS NOT NULL AND verified_at IS NULL)
    OR (state = 'destroyed' AND failure_code IS NULL AND verified_at IS NOT NULL)),
  CHECK ((reappearance_detected_at IS NULL AND reappearance_reverified_at IS NULL)
    OR (state = 'destroyed' AND reappearance_detected_at IS NOT NULL))
);
CREATE INDEX evidence_upload_disposition_tenant ON evidence_upload_dispositions(tenant_id, state, receipt_id);
-- A manifest is only a prepared attachment. These are the durable domain rows
-- that make its receipts business records. Keep this view and the later-write
-- guards below in the same migration: otherwise a disposal could win between
-- manifest creation and domain submission.
-- D1 limits a compound SELECT to five terms. Nested groups preserve every durable source.
CREATE VIEW evidence_upload_durable_refs AS
  SELECT * FROM (
    SELECT command.tenant_id,
      CASE WHEN link.type = 'object' THEN json_extract(link.value, '$.ref')
        WHEN link.type = 'text' THEN link.value END AS ref
      FROM inventory_commands AS command, json_each(command.evidence_refs_json) AS link
    UNION ALL SELECT action.tenant_id,
      CASE WHEN link.type = 'object' THEN json_extract(link.value, '$.ref')
        WHEN link.type = 'text' THEN link.value END
      FROM safety_corrective_actions AS action, json_each(action.evidence_refs_json) AS link
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN safety_corrective_actions AS action ON action.tenant_id = manifest.tenant_id
        AND action.evidence_sha256 = manifest.sha256
      WHERE manifest.purpose = 'corrective_action'
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_cases AS case_record ON case_record.tenant_id = manifest.tenant_id
        AND case_record.intake_evidence_digest = manifest.sha256
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_cases AS case_record ON case_record.tenant_id = manifest.tenant_id
        AND case_record.last_evidence_digest = manifest.sha256
  )
  UNION ALL SELECT * FROM (
    SELECT manifest.tenant_id AS tenant_id, json_extract(link.value, '$.ref') AS ref
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_case_events AS event ON event.tenant_id = manifest.tenant_id
        AND event.evidence_digest = manifest.sha256
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_case_triage AS triage ON triage.tenant_id = manifest.tenant_id
        AND triage.evidence_digest = manifest.sha256
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_case_diagnoses AS diagnosis ON diagnosis.tenant_id = manifest.tenant_id
        AND diagnosis.evidence_digest = manifest.sha256
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_case_remedies AS remedy ON remedy.tenant_id = manifest.tenant_id
        AND (remedy.parts_manifest_digest = manifest.sha256 OR remedy.field_evidence_digest = manifest.sha256)
    UNION ALL SELECT manifest.tenant_id, json_extract(link.value, '$.ref')
      FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
      JOIN service_cost_recovery_claims AS claim ON claim.tenant_id = manifest.tenant_id
        AND claim.evidence_digest = manifest.sha256
  );
CREATE TRIGGER evidence_upload_disposition_insert_guard BEFORE INSERT ON evidence_upload_dispositions
WHEN NOT EXISTS (SELECT 1 FROM evidence_upload_receipts WHERE receipt_id = NEW.receipt_id AND tenant_id = NEW.tenant_id)
  OR EXISTS (SELECT 1 FROM evidence_upload_holds WHERE tenant_id = NEW.tenant_id AND receipt_id = NEW.receipt_id AND active = 1)
  OR EXISTS (SELECT 1 FROM evidence_upload_durable_refs
    WHERE tenant_id = NEW.tenant_id AND ref = 'evidence-upload://' || NEW.receipt_id)
BEGIN SELECT RAISE(ABORT, 'evidence_destruction_held_or_scope_invalid'); END;
CREATE TRIGGER evidence_upload_disposition_transition_guard BEFORE UPDATE ON evidence_upload_dispositions
WHEN NEW.receipt_id != OLD.receipt_id OR NEW.tenant_id != OLD.tenant_id OR NEW.decision_id != OLD.decision_id
  OR NEW.basis != OLD.basis OR NEW.authority_ref != OLD.authority_ref OR NEW.policy_version != OLD.policy_version
  OR NEW.reason != OLD.reason OR NEW.requested_by != OLD.requested_by OR NEW.requested_at != OLD.requested_at
  OR NOT ((OLD.state = 'destroying' AND NEW.state IN ('failed', 'destroyed')
      AND NEW.reappearance_detected_at IS NULL AND NEW.reappearance_reverified_at IS NULL)
    OR (OLD.state = 'failed' AND NEW.state = 'destroying'
      AND NOT EXISTS (SELECT 1 FROM evidence_upload_holds WHERE tenant_id = OLD.tenant_id
        AND receipt_id = OLD.receipt_id AND active = 1)
      AND NEW.reappearance_detected_at IS NULL AND NEW.reappearance_reverified_at IS NULL)
    OR (OLD.state = 'destroyed' AND NEW.state = 'destroyed'
      AND NEW.verified_at IS OLD.verified_at AND NEW.failure_code IS OLD.failure_code AND
      ((NEW.reappearance_detected_at IS NOT NULL AND NEW.reappearance_reverified_at IS NULL
        AND (OLD.reappearance_detected_at IS NULL OR OLD.reappearance_reverified_at IS NOT NULL))
      OR (OLD.reappearance_detected_at IS NOT NULL AND OLD.reappearance_reverified_at IS NULL
        AND NEW.reappearance_detected_at IS OLD.reappearance_detected_at
        AND NEW.reappearance_reverified_at IS NOT NULL))))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_transition_invalid'); END;
CREATE TRIGGER evidence_upload_disposition_immutable_delete BEFORE DELETE ON evidence_upload_dispositions
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_immutable'); END;
-- A concurrent resolver cannot create a manifest after a manual disposal starts.
-- A generic D1 writer cannot mint an upload reference without the immutable
-- receipt's exact tenant, actor, purpose, target, action, operation and digest.
CREATE TRIGGER evidence_upload_manifest_receipt_scope_guard BEFORE INSERT ON evidence_upload_manifests
WHEN json_type(NEW.refs_json) != 'array' OR json_array_length(NEW.refs_json) < 1
  OR EXISTS (SELECT 1 FROM json_each(NEW.refs_json) AS link
    WHERE link.type != 'object' OR NOT EXISTS (
      SELECT 1 FROM evidence_upload_receipts AS receipt
      WHERE receipt.tenant_id = NEW.tenant_id AND receipt.actor_user_id = NEW.actor_user_id
        AND receipt.purpose = NEW.purpose AND receipt.target_id = NEW.target_id
        AND receipt.action = NEW.action AND receipt.operation_id = NEW.operation_id
        AND json_extract(link.value, '$.ref') = 'evidence-upload://' || receipt.receipt_id
        AND json_extract(link.value, '$.sha256') = receipt.sha256))
BEGIN SELECT RAISE(ABORT, 'evidence_manifest_receipt_scope_invalid'); END;
CREATE TRIGGER evidence_upload_manifest_privacy_guard BEFORE INSERT ON evidence_upload_manifests
WHEN EXISTS (SELECT 1 FROM json_each(NEW.refs_json) AS link
  JOIN evidence_upload_dispositions AS disposition
    ON json_extract(link.value, '$.ref') = 'evidence-upload://' || disposition.receipt_id
  WHERE disposition.tenant_id = NEW.tenant_id)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_manifest'); END;

-- Once an owner disposes a manifest-only upload, the immutable manifest remains
-- for audit. No later domain statement may turn it into a business attachment.
-- These triggers and the disposition insert guard serialize that choice in D1.
CREATE VIEW evidence_upload_disposed_manifests AS
  SELECT manifest.tenant_id, manifest.sha256
    FROM evidence_upload_manifests AS manifest, json_each(manifest.refs_json) AS link
    JOIN evidence_upload_dispositions AS disposition
      ON disposition.tenant_id = manifest.tenant_id
      AND json_extract(link.value, '$.ref') = 'evidence-upload://' || disposition.receipt_id;

CREATE TRIGGER evidence_disposed_inventory_insert_guard BEFORE INSERT ON inventory_commands
WHEN EXISTS (SELECT 1 FROM json_each(NEW.evidence_refs_json) AS link
  JOIN evidence_upload_dispositions AS disposition
    ON disposition.tenant_id = NEW.tenant_id
    AND (CASE WHEN link.type = 'object' THEN json_extract(link.value, '$.ref')
      WHEN link.type = 'text' THEN link.value END) = 'evidence-upload://' || disposition.receipt_id)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_inventory_update_guard BEFORE UPDATE OF evidence_refs_json ON inventory_commands
WHEN NEW.evidence_refs_json IS NOT OLD.evidence_refs_json
  AND EXISTS (SELECT 1 FROM json_each(NEW.evidence_refs_json) AS link
    JOIN evidence_upload_dispositions AS disposition
      ON disposition.tenant_id = NEW.tenant_id
      AND (CASE WHEN link.type = 'object' THEN json_extract(link.value, '$.ref')
        WHEN link.type = 'text' THEN link.value END) = 'evidence-upload://' || disposition.receipt_id)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_corrective_insert_guard BEFORE INSERT ON safety_corrective_actions
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_sha256)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_corrective_update_guard
BEFORE UPDATE OF evidence_refs_json, evidence_sha256 ON safety_corrective_actions
WHEN (NEW.evidence_refs_json IS NOT OLD.evidence_refs_json
    OR NEW.evidence_sha256 IS NOT OLD.evidence_sha256)
  AND (EXISTS (SELECT 1 FROM json_each(NEW.evidence_refs_json) AS link
    JOIN evidence_upload_dispositions AS disposition
      ON disposition.tenant_id = NEW.tenant_id
      AND (CASE WHEN link.type = 'object' THEN json_extract(link.value, '$.ref')
        WHEN link.type = 'text' THEN link.value END) = 'evidence-upload://' || disposition.receipt_id)
    OR EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
      WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_sha256))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;

CREATE TRIGGER evidence_disposed_service_case_insert_guard BEFORE INSERT ON service_cases
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 IN (NEW.intake_evidence_digest, NEW.last_evidence_digest))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_case_update_guard
BEFORE UPDATE OF intake_evidence_digest, last_evidence_digest ON service_cases
WHEN (NEW.intake_evidence_digest IS NOT OLD.intake_evidence_digest
    OR NEW.last_evidence_digest IS NOT OLD.last_evidence_digest)
  AND EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
    WHERE tenant_id = NEW.tenant_id AND sha256 IN (NEW.intake_evidence_digest, NEW.last_evidence_digest))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_event_insert_guard BEFORE INSERT ON service_case_events
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_digest)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_triage_insert_guard BEFORE INSERT ON service_case_triage
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_digest)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_diagnosis_insert_guard BEFORE INSERT ON service_case_diagnoses
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_digest)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_remedy_insert_guard BEFORE INSERT ON service_case_remedies
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 IN (NEW.parts_manifest_digest, NEW.field_evidence_digest))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_remedy_update_guard
BEFORE UPDATE OF parts_manifest_digest, field_evidence_digest ON service_case_remedies
WHEN (NEW.parts_manifest_digest IS NOT OLD.parts_manifest_digest
    OR NEW.field_evidence_digest IS NOT OLD.field_evidence_digest)
  AND EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
    WHERE tenant_id = NEW.tenant_id AND sha256 IN (NEW.parts_manifest_digest, NEW.field_evidence_digest))
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;
CREATE TRIGGER evidence_disposed_service_claim_insert_guard BEFORE INSERT ON service_cost_recovery_claims
WHEN EXISTS (SELECT 1 FROM evidence_upload_disposed_manifests
  WHERE tenant_id = NEW.tenant_id AND sha256 = NEW.evidence_digest)
BEGIN SELECT RAISE(ABORT, 'evidence_disposition_blocks_domain_link'); END;

-- A legacy corrective command must not attach an upload receipt without the
-- tenant, target, action and digest manifest produced by receipt resolution.
-- This also closes the race between a direct legacy write and disposal.
-- An action cannot have a scoped manifest before its own row exists, so an
-- insert carrying any reserved upload reference must always be refused.
-- Search the whole ref: SQLite trim() leaves control-character padding intact.
CREATE TRIGGER safety_corrective_receipt_manifest_insert_guard
BEFORE INSERT ON safety_corrective_actions
WHEN NEW.evidence_refs_json IS NOT NULL
  AND EXISTS (SELECT 1 FROM json_each(NEW.evidence_refs_json) AS link
    WHERE instr(lower(json_extract(link.value, '$.ref')), 'evidence-upload://') > 0)
BEGIN SELECT RAISE(ABORT, 'evidence_receipt_manifest_required'); END;
CREATE TRIGGER safety_corrective_receipt_manifest_guard
BEFORE UPDATE OF evidence_refs_json ON safety_corrective_actions
WHEN NEW.evidence_refs_json IS NOT NULL AND NEW.evidence_refs_json IS NOT OLD.evidence_refs_json
  AND EXISTS (SELECT 1 FROM json_each(NEW.evidence_refs_json) AS link
    WHERE instr(lower(json_extract(link.value, '$.ref')), 'evidence-upload://') > 0
      AND NOT EXISTS (SELECT 1 FROM evidence_upload_manifests AS manifest,
        json_each(manifest.refs_json) AS resolved
        WHERE manifest.tenant_id = NEW.tenant_id AND manifest.purpose = 'corrective_action'
          AND manifest.target_id = NEW.corrective_action_id AND manifest.action = 'submit'
          AND manifest.operation_id = ''
          AND json_extract(resolved.value, '$.ref') = json_extract(link.value, '$.ref')
          AND json_extract(resolved.value, '$.sha256') = json_extract(link.value, '$.sha256')))
BEGIN SELECT RAISE(ABORT, 'evidence_receipt_manifest_required'); END;

CREATE TABLE evidence_upload_privacy_events (
  event_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL REFERENCES evidence_upload_receipts(receipt_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('hold_created', 'hold_released', 'destruction_requested',
    'destruction_failed', 'destruction_retried', 'destruction_verified',
    'reappearance_detected', 'destruction_reverified')),
  actor_user_id TEXT NOT NULL,
  authority_ref TEXT,
  decision_id TEXT,
  reason TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX evidence_upload_privacy_events_scope ON evidence_upload_privacy_events(tenant_id, receipt_id, recorded_at, event_id);
CREATE TRIGGER evidence_upload_privacy_event_immutable_update BEFORE UPDATE ON evidence_upload_privacy_events
BEGIN SELECT RAISE(ABORT, 'evidence_privacy_event_immutable'); END;
CREATE TRIGGER evidence_upload_privacy_event_immutable_delete BEFORE DELETE ON evidence_upload_privacy_events
BEGIN SELECT RAISE(ABORT, 'evidence_privacy_event_immutable'); END;
CREATE TRIGGER evidence_upload_hold_created_event AFTER INSERT ON evidence_upload_holds
BEGIN INSERT INTO evidence_upload_privacy_events VALUES
  (lower(hex(randomblob(16))), NEW.tenant_id, NEW.receipt_id, 'hold_created', NEW.created_by,
    NEW.hold_id, NULL, NEW.reason, NEW.created_at); END;
CREATE TRIGGER evidence_upload_hold_released_event AFTER UPDATE ON evidence_upload_holds
BEGIN INSERT INTO evidence_upload_privacy_events VALUES
  (lower(hex(randomblob(16))), NEW.tenant_id, NEW.receipt_id, 'hold_released', NEW.released_by,
    NEW.hold_id, NULL, NEW.release_reason, NEW.released_at); END;
CREATE TRIGGER evidence_upload_destruction_requested_event AFTER INSERT ON evidence_upload_dispositions
BEGIN INSERT INTO evidence_upload_privacy_events VALUES
  (lower(hex(randomblob(16))), NEW.tenant_id, NEW.receipt_id, 'destruction_requested', NEW.requested_by,
    NEW.authority_ref, NEW.decision_id, NEW.reason, NEW.requested_at); END;
CREATE TRIGGER evidence_upload_destruction_transition_event AFTER UPDATE ON evidence_upload_dispositions
BEGIN INSERT INTO evidence_upload_privacy_events VALUES
  (lower(hex(randomblob(16))), NEW.tenant_id, NEW.receipt_id,
    CASE WHEN OLD.state = 'destroyed' AND NEW.reappearance_reverified_at IS NULL
      THEN 'reappearance_detected'
      WHEN OLD.state = 'destroyed' THEN 'destruction_reverified'
      WHEN NEW.state = 'failed' THEN 'destruction_failed'
      WHEN NEW.state = 'destroying' THEN 'destruction_retried' ELSE 'destruction_verified' END,
    NEW.last_actor_user_id, NEW.authority_ref, NEW.decision_id,
    CASE WHEN OLD.state = 'destroyed' AND NEW.reappearance_reverified_at IS NULL
      THEN 'Stored bytes reappeared after destruction'
      WHEN OLD.state = 'destroyed' THEN 'Restored bytes removed and absence verified'
      ELSE COALESCE(NEW.failure_code, NEW.reason) END, NEW.last_transition_at); END;
