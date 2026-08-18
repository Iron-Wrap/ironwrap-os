-- 0038_app_access_roles.sql - least-privilege human work roles without rebuilding app_users.
--
-- The original role column is a deployed authentication-class constraint. SQLite cannot widen
-- its CHECK in place, and rebuilding this referenced parent table could activate ON DELETE
-- actions. access_role is therefore the sole effective application role. Existing rows are
-- materialized from the legacy role once; specialized office users retain a compatible storage
-- role while carrying their narrower authority explicitly.

ALTER TABLE app_users ADD COLUMN access_role TEXT CHECK (
  access_role IS NULL OR access_role IN (
    'owner', 'ops', 'sales', 'admin', 'production', 'shop', 'accounting', 'field'
  )
);

UPDATE app_users SET access_role = role WHERE access_role IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_users_tenant_access_role_active
  ON app_users (tenant_id, active, access_role, updated_at);

-- Facet association authorization is enforced in D1 as well as the BFF. It must use the
-- effective role so a sales user stored under the legacy office class cannot inherit owner/ops
-- authority through the compatibility column.
DROP TRIGGER IF EXISTS facet_design_evidence_associations_validate_insert;
CREATE TRIGGER facet_design_evidence_associations_validate_insert
BEFORE INSERT ON facet_design_evidence_associations
BEGIN
  SELECT RAISE(ABORT, 'facet_design_association_event_anchor_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM facet_customer_approval_events AS event
    WHERE event.event_id = NEW.event_id
      AND event.event_type = 'facet.design.customer_approved.v2'
      AND event.schema_version = 2
      AND event.approval_actor_type = 'customer_capability'
      AND event.identity_assurance = 'bearer_capability_only'
      AND event.tenant_id = NEW.tenant_id
      AND event.brand_id = NEW.brand_id
      AND event.facet_project_id = NEW.facet_project_id
      AND event.design_revision_id = NEW.design_revision_id
      AND event.design_revision_sha256 = NEW.design_revision_sha256
      AND event.frozen_evidence_sha256 = NEW.frozen_evidence_sha256
  );
  SELECT RAISE(ABORT, 'facet_design_association_office_actor_required')
  WHERE NOT EXISTS (
    SELECT 1
    FROM app_users AS actor
    WHERE actor.user_id = NEW.associated_by_user_id
      AND actor.tenant_id = NEW.tenant_id
      AND actor.active = 1
      AND actor.access_role IN ('owner', 'ops')
  );
END;
