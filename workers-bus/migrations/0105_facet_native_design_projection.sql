-- 0105_facet_native_design_projection.sql - materialize signed Facet v2
-- decisions as native design authority without inventing a commercial quote.
--
-- The legacy facet_v2_projection_attempts table is retained as immutable
-- historical evidence. The active path writes only these native tables.

CREATE TABLE IF NOT EXISTS facet_v2_native_design_projections (
  projection_id TEXT PRIMARY KEY CHECK (
    projection_id GLOB 'facet-native-design-v2:*'
    AND length(projection_id) = 87
  ),
  event_id TEXT NOT NULL UNIQUE,
  destination_tenant_id TEXT NOT NULL,
  source_tenant_id TEXT NOT NULL,
  brand_id TEXT NOT NULL,
  facet_project_id TEXT NOT NULL,
  external_project_link_id TEXT NOT NULL,
  producer_identity_link_id TEXT NOT NULL,
  external_customer_identity_link_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
  source_quote_revision_id TEXT NOT NULL,
  source_quote_version INTEGER NOT NULL CHECK (source_quote_version BETWEEN 1 AND 1000000),
  source_quote_approved_at TEXT NOT NULL CHECK (length(source_quote_approved_at) BETWEEN 20 AND 40),
  source_proposal_revision_id TEXT NOT NULL,
  source_proposal_pack_id TEXT NOT NULL,
  source_publication_event_id TEXT NOT NULL,
  source_acceptance_binding_id TEXT NOT NULL,
  source_acceptance_id TEXT NOT NULL,
  source_acceptance_accepted_at TEXT NOT NULL CHECK (
    length(source_acceptance_accepted_at) BETWEEN 20 AND 40
  ),
  source_acceptance_receipt_hash TEXT NOT NULL CHECK (
    length(source_acceptance_receipt_hash) = 64
    AND source_acceptance_receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  launch_intent_sha256 TEXT NOT NULL CHECK (
    length(launch_intent_sha256) = 64
    AND launch_intent_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  decision_kind TEXT NOT NULL CHECK (
    decision_kind IN ('approved', 'corrected', 'superseded', 'withdrawn')
  ),
  design_sequence INTEGER NOT NULL CHECK (design_sequence BETWEEN 1 AND 100),
  design_state TEXT NOT NULL CHECK (design_state IN ('active', 'withdrawn', 'superseded')),
  previous_event_id TEXT,
  design_revision_id TEXT NOT NULL,
  design_revision_sha256 TEXT NOT NULL CHECK (
    length(design_revision_sha256) = 64
    AND design_revision_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  frozen_evidence_sha256 TEXT NOT NULL CHECK (
    length(frozen_evidence_sha256) = 64
    AND frozen_evidence_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  raw_sha256 TEXT NOT NULL CHECK (
    length(raw_sha256) = 64 AND raw_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  projection_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(projection_sha256) = 64
    AND projection_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  projected_at TEXT NOT NULL CHECK (length(projected_at) BETWEEN 20 AND 40),
  CHECK (
    (decision_kind IN ('approved', 'corrected') AND design_state = 'active')
    OR (decision_kind = 'withdrawn' AND design_state = 'withdrawn')
    OR (decision_kind = 'superseded' AND design_state = 'superseded')
  ),
  UNIQUE (projection_id, event_id, projection_sha256),
  UNIQUE (destination_tenant_id, facet_project_id, design_sequence),
  FOREIGN KEY (event_id)
    REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_project_link_id)
    REFERENCES facet_v2_project_links(external_project_link_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_quote_revision_id, destination_tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_proposal_revision_id, destination_tenant_id)
    REFERENCES commercial_proposal_revisions(proposal_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_publication_event_id, destination_tenant_id)
    REFERENCES commercial_proposal_publication_events(publication_event_id, tenant_id)
      ON DELETE RESTRICT,
  FOREIGN KEY (source_acceptance_binding_id, destination_tenant_id)
    REFERENCES commercial_acceptance_bindings(acceptance_binding_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (previous_event_id)
    REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_native_design_current
  ON facet_v2_native_design_projections (
    destination_tenant_id, facet_project_id, design_sequence DESC
  );
CREATE INDEX IF NOT EXISTS idx_facet_v2_native_design_job
  ON facet_v2_native_design_projections (
    destination_tenant_id, roof_job_id, projected_at DESC
  );

CREATE TABLE IF NOT EXISTS facet_v2_native_projection_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (
    length(attempt_id) BETWEEN 32 AND 180
    AND attempt_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  event_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'projected_native_design', 'reconciled_native_design',
    'held_withdrawn', 'held_superseded', 'rejected', 'uncertain'
  )),
  projection_id TEXT,
  projection_sha256 TEXT,
  error_code TEXT,
  attempted_at TEXT NOT NULL CHECK (length(attempted_at) BETWEEN 20 AND 40),
  CHECK (
    (
      outcome IN (
        'projected_native_design', 'reconciled_native_design',
        'held_withdrawn', 'held_superseded'
      )
      AND projection_id IS NOT NULL
      AND projection_sha256 IS NOT NULL
      AND error_code IS NULL
    )
    OR (
      outcome IN ('rejected', 'uncertain')
      AND projection_id IS NULL
      AND projection_sha256 IS NULL
      AND length(trim(error_code)) BETWEEN 3 AND 180
    )
  ),
  FOREIGN KEY (event_id)
    REFERENCES facet_v2_customer_decisions(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (projection_id, event_id, projection_sha256)
    REFERENCES facet_v2_native_design_projections(
      projection_id, event_id, projection_sha256
    ) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_facet_v2_native_projection_attempts_event
  ON facet_v2_native_projection_attempts (event_id, attempted_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_facet_v2_native_projection_one_final
  ON facet_v2_native_projection_attempts (event_id)
  WHERE outcome <> 'uncertain';

CREATE TRIGGER IF NOT EXISTS facet_v2_native_design_projection_guard
BEFORE INSERT ON facet_v2_native_design_projections
BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_design_decision_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM facet_v2_customer_decisions decision
     WHERE decision.event_id = NEW.event_id
       AND decision.destination_tenant_id = NEW.destination_tenant_id
       AND decision.source_tenant_id = NEW.source_tenant_id
       AND decision.brand_id = NEW.brand_id
       AND decision.facet_project_id = NEW.facet_project_id
       AND decision.external_project_link_id = NEW.external_project_link_id
       AND decision.producer_identity_link_id = NEW.producer_identity_link_id
       AND decision.external_customer_identity_link_id = NEW.external_customer_identity_link_id
       AND decision.roof_job_id = NEW.roof_job_id
       AND decision.customer_quote_id = NEW.customer_quote_id
       AND decision.decision_kind = NEW.decision_kind
       AND decision.previous_event_id IS NEW.previous_event_id
       AND decision.design_revision_id = NEW.design_revision_id
       AND decision.design_revision_sha256 = NEW.design_revision_sha256
       AND decision.frozen_evidence_sha256 = NEW.frozen_evidence_sha256
       AND decision.raw_sha256 = NEW.raw_sha256
  );
  SELECT RAISE(ABORT, 'facet_v2_native_design_decision_not_current')
  WHERE EXISTS (
    SELECT 1
      FROM facet_v2_customer_decisions child
     WHERE child.previous_event_id = NEW.event_id
  );
  SELECT RAISE(ABORT, 'facet_v2_native_design_authority_revoked')
  WHERE EXISTS (
    SELECT 1
      FROM facet_v2_link_revocations revoked
     WHERE revoked.destination_tenant_id = NEW.destination_tenant_id
       AND (
         (revoked.link_kind = 'project'
          AND revoked.link_id = NEW.external_project_link_id)
         OR (revoked.link_kind = 'producer_identity'
          AND revoked.link_id = NEW.producer_identity_link_id)
         OR (revoked.link_kind = 'customer_identity'
          AND revoked.link_id = NEW.external_customer_identity_link_id)
       )
  );
  SELECT RAISE(ABORT, 'facet_v2_native_design_launch_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM facet_v2_project_launches launch
     WHERE launch.destination_tenant_id = NEW.destination_tenant_id
       AND launch.source_tenant_id = NEW.source_tenant_id
       AND launch.brand_id = NEW.brand_id
       AND launch.facet_project_id = NEW.facet_project_id
       AND launch.external_project_link_id = NEW.external_project_link_id
       AND launch.roof_job_id = NEW.roof_job_id
       AND launch.customer_quote_id = NEW.customer_quote_id
       AND launch.quote_version = NEW.source_quote_version
       AND launch.quote_approved_at = NEW.source_quote_approved_at
       AND launch.external_customer_identity_link_id = NEW.external_customer_identity_link_id
       AND launch.launch_intent_sha256 = NEW.launch_intent_sha256
  );
  SELECT RAISE(ABORT, 'facet_v2_native_design_commercial_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_quote_revisions quote
      JOIN commercial_proposal_revisions proposal
        ON proposal.tenant_id = quote.tenant_id
       AND proposal.quote_revision_id = quote.quote_revision_id
      JOIN commercial_proposal_publication_events publication
        ON publication.tenant_id = proposal.tenant_id
       AND publication.proposal_revision_id = proposal.proposal_revision_id
       AND publication.proposal_pack_id = proposal.proposal_pack_id
      JOIN commercial_acceptance_bindings acceptance
        ON acceptance.tenant_id = proposal.tenant_id
       AND acceptance.quote_revision_id = quote.quote_revision_id
       AND acceptance.proposal_revision_id = proposal.proposal_revision_id
     WHERE quote.tenant_id = NEW.destination_tenant_id
       AND quote.quote_revision_id = NEW.source_quote_revision_id
       AND quote.customer_quote_id = NEW.customer_quote_id
       AND quote.revision_number = NEW.source_quote_version
       AND quote.created_at = NEW.source_quote_approved_at
       AND quote.roof_job_id = NEW.roof_job_id
       AND quote.customer_id = NEW.customer_id
       AND quote.status = 'approved'
       AND proposal.proposal_revision_id = NEW.source_proposal_revision_id
       AND proposal.proposal_pack_id = NEW.source_proposal_pack_id
       AND proposal.roof_job_id = NEW.roof_job_id
       AND proposal.customer_id = NEW.customer_id
       AND publication.publication_event_id = NEW.source_publication_event_id
       AND publication.state = 'published'
       AND acceptance.acceptance_binding_id = NEW.source_acceptance_binding_id
       AND acceptance.acceptance_id = NEW.source_acceptance_id
       AND acceptance.roof_job_id = NEW.roof_job_id
       AND acceptance.customer_id = NEW.customer_id
       AND acceptance.terms_hash = quote.terms_hash
       AND acceptance.accepted_at = NEW.source_acceptance_accepted_at
       AND acceptance.receipt_hash = NEW.source_acceptance_receipt_hash
       AND proposal.terms_hash = quote.terms_hash
       AND quote.created_at <= proposal.created_at
       AND proposal.created_at <= publication.occurred_at
       AND publication.occurred_at <= acceptance.accepted_at
       AND acceptance.accepted_at <= acceptance.bound_at
       AND NOT EXISTS (
         SELECT 1 FROM commercial_quote_revisions newer_quote
          WHERE newer_quote.tenant_id = quote.tenant_id
            AND newer_quote.customer_quote_id = quote.customer_quote_id
            AND newer_quote.revision_number > quote.revision_number
       )
       AND NOT EXISTS (
         SELECT 1 FROM commercial_proposal_revisions newer_proposal
          WHERE newer_proposal.tenant_id = proposal.tenant_id
            AND newer_proposal.proposal_pack_id = proposal.proposal_pack_id
            AND newer_proposal.revision_number > proposal.revision_number
       )
       AND NOT EXISTS (
         SELECT 1 FROM commercial_proposal_publication_events newer_publication
          WHERE newer_publication.tenant_id = publication.tenant_id
            AND newer_publication.proposal_pack_id = publication.proposal_pack_id
            AND newer_publication.publication_version > publication.publication_version
       )
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_acceptance_bindings competing_acceptance
           JOIN commercial_quote_revisions competing_quote
             ON competing_quote.tenant_id = competing_acceptance.tenant_id
            AND competing_quote.quote_revision_id = competing_acceptance.quote_revision_id
           JOIN commercial_proposal_revisions competing_proposal
             ON competing_proposal.tenant_id = competing_acceptance.tenant_id
            AND competing_proposal.proposal_revision_id = competing_acceptance.proposal_revision_id
           JOIN commercial_proposal_publication_events competing_publication
             ON competing_publication.tenant_id = competing_proposal.tenant_id
            AND competing_publication.proposal_revision_id = competing_proposal.proposal_revision_id
            AND competing_publication.proposal_pack_id = competing_proposal.proposal_pack_id
          WHERE competing_acceptance.acceptance_binding_id <> acceptance.acceptance_binding_id
            AND competing_acceptance.tenant_id = acceptance.tenant_id
            AND competing_acceptance.roof_job_id = acceptance.roof_job_id
            AND competing_acceptance.customer_id = acceptance.customer_id
            AND competing_quote.status = 'approved'
            AND competing_quote.roof_job_id = competing_acceptance.roof_job_id
            AND competing_quote.customer_id = competing_acceptance.customer_id
            AND competing_proposal.roof_job_id = competing_acceptance.roof_job_id
            AND competing_proposal.customer_id = competing_acceptance.customer_id
            AND competing_proposal.quote_revision_id = competing_quote.quote_revision_id
            AND competing_proposal.terms_hash = competing_quote.terms_hash
            AND competing_acceptance.terms_hash = competing_quote.terms_hash
            AND competing_publication.state = 'published'
            AND competing_quote.created_at <= competing_proposal.created_at
            AND competing_proposal.created_at <= competing_publication.occurred_at
            AND competing_publication.occurred_at <= competing_acceptance.accepted_at
            AND competing_acceptance.accepted_at <= competing_acceptance.bound_at
            AND NOT EXISTS (
              SELECT 1 FROM commercial_quote_revisions newer_competing_quote
               WHERE newer_competing_quote.tenant_id = competing_quote.tenant_id
                 AND newer_competing_quote.customer_quote_id = competing_quote.customer_quote_id
                 AND newer_competing_quote.revision_number > competing_quote.revision_number
            )
            AND NOT EXISTS (
              SELECT 1 FROM commercial_proposal_revisions newer_competing_proposal
               WHERE newer_competing_proposal.tenant_id = competing_proposal.tenant_id
                 AND newer_competing_proposal.proposal_pack_id = competing_proposal.proposal_pack_id
                 AND newer_competing_proposal.revision_number > competing_proposal.revision_number
            )
            AND NOT EXISTS (
              SELECT 1 FROM commercial_proposal_publication_events newer_competing_publication
               WHERE newer_competing_publication.tenant_id = competing_publication.tenant_id
                 AND newer_competing_publication.proposal_pack_id = competing_publication.proposal_pack_id
                 AND newer_competing_publication.publication_version > competing_publication.publication_version
            )
       )
  );
END;

CREATE TRIGGER IF NOT EXISTS facet_v2_native_projection_attempt_guard
BEFORE INSERT ON facet_v2_native_projection_attempts
WHEN NEW.outcome <> 'uncertain' AND NEW.outcome <> 'rejected'
BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_projection_outcome_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM facet_v2_native_design_projections projection
     WHERE projection.projection_id = NEW.projection_id
       AND projection.event_id = NEW.event_id
       AND projection.projection_sha256 = NEW.projection_sha256
       AND (
         (NEW.outcome IN ('projected_native_design', 'reconciled_native_design')
           AND projection.design_state = 'active')
         OR (NEW.outcome = 'held_withdrawn' AND projection.design_state = 'withdrawn')
         OR (NEW.outcome = 'held_superseded' AND projection.design_state = 'superseded')
       )
  );
  SELECT RAISE(ABORT, 'facet_v2_native_projection_reconciliation_missing')
  WHERE NEW.outcome = 'reconciled_native_design'
    AND NOT EXISTS (
      SELECT 1 FROM facet_v2_native_projection_attempts prior
       WHERE prior.event_id = NEW.event_id AND prior.outcome = 'uncertain'
    );
  SELECT RAISE(ABORT, 'facet_v2_native_projection_reconciliation_required')
  WHERE NEW.outcome = 'projected_native_design'
    AND EXISTS (
      SELECT 1 FROM facet_v2_native_projection_attempts prior
       WHERE prior.event_id = NEW.event_id AND prior.outcome = 'uncertain'
    );
END;

CREATE TRIGGER IF NOT EXISTS facet_v2_native_design_projections_no_insert_replace
BEFORE INSERT ON facet_v2_native_design_projections
WHEN EXISTS (
  SELECT 1 FROM facet_v2_native_design_projections retained
   WHERE retained.projection_id = NEW.projection_id
      OR retained.event_id = NEW.event_id
      OR retained.projection_sha256 = NEW.projection_sha256
      OR (
        retained.destination_tenant_id = NEW.destination_tenant_id
        AND retained.facet_project_id = NEW.facet_project_id
        AND retained.design_sequence = NEW.design_sequence
      )
)
BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_design_projections_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_v2_native_projection_attempts_no_insert_replace
BEFORE INSERT ON facet_v2_native_projection_attempts
WHEN EXISTS (
  SELECT 1 FROM facet_v2_native_projection_attempts retained
   WHERE retained.attempt_id = NEW.attempt_id
)
BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_projection_attempts_append_only');
END;

CREATE TRIGGER IF NOT EXISTS facet_v2_native_design_projections_append_only_update
BEFORE UPDATE ON facet_v2_native_design_projections BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_design_projections_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_native_design_projections_append_only_delete
BEFORE DELETE ON facet_v2_native_design_projections BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_design_projections_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_native_projection_attempts_append_only_update
BEFORE UPDATE ON facet_v2_native_projection_attempts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_projection_attempts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS facet_v2_native_projection_attempts_append_only_delete
BEFORE DELETE ON facet_v2_native_projection_attempts BEGIN
  SELECT RAISE(ABORT, 'facet_v2_native_projection_attempts_append_only');
END;
