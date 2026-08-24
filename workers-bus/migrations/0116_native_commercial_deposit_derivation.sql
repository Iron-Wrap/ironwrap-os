-- 0116_native_commercial_deposit_derivation.sql - acceptance to accounting handoff.
--
-- A customer acceptance is a durable commercial fact.  This queue is created by the same D1
-- transaction as the acceptance binding, so a committed acceptance always has one recoverable
-- deposit derivation record.  It is deliberately not an accounting intent: provider mapping,
-- tax policy, and the accounting ceiling are read at derivation time and only the accounting
-- intent aggregate may become provider-facing work.

CREATE TABLE commercial_deposit_derivations (
  derivation_id TEXT PRIMARY KEY CHECK (
    length(derivation_id) BETWEEN 32 AND 220
    AND derivation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  acceptance_binding_id TEXT NOT NULL UNIQUE,
  acceptance_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  quote_revision_id TEXT NOT NULL,
  proposal_revision_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL CHECK (proposal_version BETWEEN 1 AND 1000000),
  publication_event_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version BETWEEN 1 AND 1000000),
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_quote_id TEXT NOT NULL,
  quote_version INTEGER NOT NULL CHECK (quote_version BETWEEN 1 AND 1000000),
  quote_currency TEXT NOT NULL CHECK (quote_currency = 'CAD'),
  quote_subtotal_cents INTEGER NOT NULL CHECK (quote_subtotal_cents >= 0),
  quote_tax_cents INTEGER NOT NULL CHECK (quote_tax_cents >= 0),
  quote_total_cents INTEGER NOT NULL CHECK (
    quote_total_cents = quote_subtotal_cents + quote_tax_cents
  ),
  deposit_percent INTEGER NOT NULL CHECK (deposit_percent BETWEEN 0 AND 100),
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_hash TEXT NOT NULL CHECK (
    length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) BETWEEN 20 AND 40),
  basis_json TEXT NOT NULL CHECK (length(basis_json) BETWEEN 2 AND 65536 AND json_valid(basis_json)),
  basis_sha256 TEXT CHECK (
    basis_sha256 IS NULL OR (
      length(basis_sha256) = 64 AND basis_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'blocked', 'derived')),
  intent_id TEXT,
  blocker_code TEXT CHECK (blocker_code IS NULL OR length(blocker_code) BETWEEN 1 AND 120),
  blocker_next_step TEXT CHECK (
    blocker_next_step IS NULL OR length(blocker_next_step) BETWEEN 1 AND 160
  ),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (derivation_id, tenant_id),
  FOREIGN KEY (acceptance_binding_id)
    REFERENCES commercial_acceptance_bindings(acceptance_binding_id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_id)
    REFERENCES customer_portal_acceptance_intents(acceptance_id) ON DELETE RESTRICT,
  FOREIGN KEY (quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_revision_id, tenant_id)
    REFERENCES commercial_proposal_revisions(proposal_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (publication_event_id, tenant_id)
    REFERENCES commercial_proposal_publication_events(publication_event_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id)
    REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  CHECK ((state = 'derived') = (intent_id IS NOT NULL)),
  CHECK ((state = 'blocked') = (blocker_code IS NOT NULL AND blocker_next_step IS NOT NULL)),
  CHECK (state != 'pending' OR (blocker_code IS NULL AND blocker_next_step IS NULL AND intent_id IS NULL)),
  CHECK (state != 'derived' OR blocker_code IS NULL AND blocker_next_step IS NULL)
);

CREATE UNIQUE INDEX idx_commercial_deposit_derivations_basis
  ON commercial_deposit_derivations (tenant_id, basis_sha256)
  WHERE basis_sha256 IS NOT NULL;

CREATE UNIQUE INDEX idx_commercial_deposit_derivations_intent
  ON commercial_deposit_derivations (tenant_id, intent_id)
  WHERE intent_id IS NOT NULL;

CREATE INDEX idx_commercial_deposit_derivations_recovery
  ON commercial_deposit_derivations (tenant_id, state, updated_at, derivation_id);

CREATE TABLE commercial_deposit_derivation_cursors (
  cursor_name TEXT PRIMARY KEY CHECK (cursor_name = 'scheduled-v1'),
  last_tenant_id TEXT NOT NULL CHECK (
    length(last_tenant_id) BETWEEN 2 AND 64
    AND last_tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  last_acceptance_id TEXT NOT NULL CHECK (length(last_acceptance_id) BETWEEN 16 AND 100),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
);

CREATE TABLE commercial_deposit_derivation_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 32 AND 240
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  derivation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version BETWEEN 1 AND 1000000),
  event_type TEXT NOT NULL CHECK (event_type IN ('enqueued', 'blocked', 'derived')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'blocked', 'derived')),
  intent_id TEXT,
  blocker_code TEXT,
  blocker_next_step TEXT,
  basis_sha256 TEXT,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  UNIQUE (derivation_id, event_version),
  FOREIGN KEY (derivation_id, tenant_id)
    REFERENCES commercial_deposit_derivations(derivation_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT
);

CREATE INDEX idx_commercial_deposit_derivation_events_lookup
  ON commercial_deposit_derivation_events (tenant_id, derivation_id, event_version);

-- Authenticated recovery requests have their own idempotency receipt.  The acceptance's
-- idempotency key remains part of the immutable commercial source; this second receipt binds a
-- staff retry to its actor and command without allowing the browser to supply accounting truth.
CREATE TABLE commercial_deposit_derivation_requests (
  request_id TEXT PRIMARY KEY CHECK (
    length(request_id) BETWEEN 32 AND 180
    AND request_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL,
  derivation_id TEXT NOT NULL,
  acceptance_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  authority_ref TEXT NOT NULL CHECK (length(authority_ref) BETWEEN 1 AND 160),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'derived', 'blocked', 'failed')),
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  derivation_version INTEGER NOT NULL CHECK (derivation_version BETWEEN 1 AND 1000000),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (request_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (derivation_id, tenant_id)
    REFERENCES commercial_deposit_derivations(derivation_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (acceptance_id)
    REFERENCES customer_portal_acceptance_intents(acceptance_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CHECK (state != 'failed' OR derivation_version >= 1)
);

CREATE INDEX idx_commercial_deposit_derivation_requests_lookup
  ON commercial_deposit_derivation_requests (tenant_id, acceptance_id, created_at DESC);

CREATE TRIGGER commercial_deposit_derivation_requests_update_guard
BEFORE UPDATE ON commercial_deposit_derivation_requests
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_request_identity_immutable')
   WHERE NEW.request_id != OLD.request_id
      OR NEW.tenant_id != OLD.tenant_id
      OR NEW.derivation_id != OLD.derivation_id
      OR NEW.acceptance_id != OLD.acceptance_id
      OR NEW.actor_user_id != OLD.actor_user_id
      OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
      OR NEW.command_fingerprint != OLD.command_fingerprint
      OR NEW.authority_ref != OLD.authority_ref
      OR NEW.policy_version != OLD.policy_version
      OR NEW.evidence_refs_json != OLD.evidence_refs_json
      OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_request_version_conflict')
   WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_request_transition_invalid')
   WHERE NOT (
     (OLD.state = 'pending' AND NEW.state IN ('pending', 'derived', 'blocked', 'failed'))
     OR (OLD.state IN ('derived', 'blocked', 'failed') AND NEW.state = OLD.state)
   );
END;

CREATE TRIGGER commercial_deposit_derivation_requests_no_insert_replace
BEFORE INSERT ON commercial_deposit_derivation_requests
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_request_exists')
   WHERE EXISTS (
     SELECT 1 FROM commercial_deposit_derivation_requests existing
      WHERE existing.request_id = NEW.request_id
         OR (existing.tenant_id = NEW.tenant_id
             AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
   );
END;

CREATE TRIGGER commercial_deposit_derivations_insert_event
AFTER INSERT ON commercial_deposit_derivations
BEGIN
  INSERT INTO commercial_deposit_derivation_events (
    event_id, derivation_id, tenant_id, event_version, event_type, state, intent_id,
    blocker_code, blocker_next_step, basis_sha256, command_fingerprint, evidence_refs_json, occurred_at
  ) VALUES (
    'commercial-deposit-event:' || NEW.derivation_id || ':v' || NEW.version,
    NEW.derivation_id, NEW.tenant_id, NEW.version, 'enqueued', NEW.state, NEW.intent_id,
    NEW.blocker_code, NEW.blocker_next_step, NEW.basis_sha256, NEW.command_fingerprint, NEW.evidence_refs_json, NEW.updated_at
  );
END;

CREATE TRIGGER commercial_deposit_derivations_update_guard
BEFORE UPDATE ON commercial_deposit_derivations
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_identity_immutable')
   WHERE NEW.derivation_id != OLD.derivation_id
      OR NEW.acceptance_binding_id != OLD.acceptance_binding_id
      OR NEW.acceptance_id != OLD.acceptance_id
      OR NEW.tenant_id != OLD.tenant_id
      OR NEW.quote_revision_id != OLD.quote_revision_id
      OR NEW.proposal_revision_id != OLD.proposal_revision_id
      OR NEW.proposal_version != OLD.proposal_version
      OR NEW.publication_event_id != OLD.publication_event_id
      OR NEW.publication_version != OLD.publication_version
      OR NEW.roof_job_id != OLD.roof_job_id
      OR NEW.customer_id != OLD.customer_id
      OR NEW.customer_quote_id != OLD.customer_quote_id
      OR NEW.quote_version != OLD.quote_version
      OR NEW.quote_currency != OLD.quote_currency
      OR NEW.quote_subtotal_cents != OLD.quote_subtotal_cents
      OR NEW.quote_tax_cents != OLD.quote_tax_cents
      OR NEW.quote_total_cents != OLD.quote_total_cents
      OR NEW.deposit_percent != OLD.deposit_percent
      OR NEW.terms_hash != OLD.terms_hash
      OR NEW.receipt_hash != OLD.receipt_hash
      OR NEW.accepted_at != OLD.accepted_at
      OR NEW.basis_json != OLD.basis_json
      OR NEW.evidence_refs_json != OLD.evidence_refs_json
      OR NEW.command_fingerprint != OLD.command_fingerprint
      OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
      OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_version_conflict')
   WHERE NEW.version != OLD.version + 1;
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_transition_invalid')
   WHERE NOT (
     (OLD.state = 'pending' AND NEW.state IN ('pending', 'blocked', 'derived'))
     OR (OLD.state = 'blocked' AND NEW.state IN ('blocked', 'derived'))
     OR (OLD.state = 'derived' AND NEW.state = 'derived' AND NEW.intent_id = OLD.intent_id)
   );
END;

CREATE TRIGGER commercial_deposit_derivations_update_event
AFTER UPDATE ON commercial_deposit_derivations
WHEN NEW.state != OLD.state OR NEW.intent_id IS NOT OLD.intent_id OR NEW.blocker_code IS NOT OLD.blocker_code
BEGIN
  INSERT INTO commercial_deposit_derivation_events (
    event_id, derivation_id, tenant_id, event_version, event_type, state, intent_id,
    blocker_code, blocker_next_step, basis_sha256, command_fingerprint, evidence_refs_json, occurred_at
  ) VALUES (
    'commercial-deposit-event:' || NEW.derivation_id || ':v' || NEW.version,
    NEW.derivation_id, NEW.tenant_id, NEW.version,
    CASE NEW.state WHEN 'derived' THEN 'derived' ELSE 'blocked' END,
    NEW.state, NEW.intent_id, NEW.blocker_code, NEW.blocker_next_step, NEW.basis_sha256, NEW.command_fingerprint,
    NEW.evidence_refs_json, NEW.updated_at
  );
END;

CREATE TRIGGER commercial_deposit_derivations_no_insert_replace
BEFORE INSERT ON commercial_deposit_derivations
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_derivation_exists')
   WHERE EXISTS (
     SELECT 1 FROM commercial_deposit_derivations existing
      WHERE existing.derivation_id = NEW.derivation_id
         OR existing.acceptance_binding_id = NEW.acceptance_binding_id
         OR existing.acceptance_id = NEW.acceptance_id
         OR (existing.tenant_id = NEW.tenant_id
             AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
   );
END;

-- Acceptance is the authoritative activation event in the native model.  These are projections,
-- not browser-writable lifecycle commands: customer/lead identity and versions come from the
-- already validated binding above, and the version guards on the operating tables still apply.
-- 0093 is already shipped. Replace its acceptance guard in-place so upgraded databases receive
-- the same qualification, current-head, approved-quote, and exact terms-chain checks as fresh
-- installs. A converted lead is accepted only for a superseding quote correction; the public
-- customer snapshot/commit path applies the same exact current-head predicate.
DROP TRIGGER IF EXISTS commercial_publication_sequence_guard;
CREATE TRIGGER commercial_publication_sequence_guard
BEFORE INSERT ON commercial_proposal_publication_events
BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_sequence_conflict')
   WHERE NEW.publication_version != COALESCE((
     SELECT MAX(publication_version) + 1
       FROM commercial_proposal_publication_events
      WHERE tenant_id = NEW.tenant_id AND proposal_pack_id = NEW.proposal_pack_id
   ), 1);
  SELECT RAISE(ABORT, 'commercial_publication_state_conflict')
   WHERE NEW.previous_state IS NOT COALESCE((
     SELECT state
       FROM commercial_proposal_publication_events
      WHERE tenant_id = NEW.tenant_id AND proposal_pack_id = NEW.proposal_pack_id
      ORDER BY publication_version DESC LIMIT 1
   ), 'draft');
  SELECT RAISE(ABORT, 'commercial_publication_proposal_not_current') WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_proposal_revisions proposal
     WHERE proposal.proposal_revision_id = NEW.proposal_revision_id
       AND proposal.tenant_id = NEW.tenant_id
       AND proposal.proposal_pack_id = NEW.proposal_pack_id
       AND NOT EXISTS (
         SELECT 1 FROM commercial_proposal_revisions successor
          WHERE successor.tenant_id = proposal.tenant_id
            AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
       )
       AND NOT EXISTS (
         SELECT 1
           FROM commercial_proposal_revisions other
          WHERE other.tenant_id = proposal.tenant_id
            AND other.proposal_pack_id = proposal.proposal_pack_id
            AND other.proposal_revision_id != proposal.proposal_revision_id
            AND NOT EXISTS (
              SELECT 1 FROM commercial_proposal_revisions other_successor
               WHERE other_successor.tenant_id = other.tenant_id
                 AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
            )
       )
  );
  SELECT RAISE(ABORT, 'commercial_publication_time_conflict')
   WHERE EXISTS (
     SELECT 1
       FROM commercial_proposal_publication_events prior
      WHERE prior.tenant_id = NEW.tenant_id
        AND prior.proposal_pack_id = NEW.proposal_pack_id
        AND prior.occurred_at >= NEW.occurred_at
   );
END;

DROP TRIGGER IF EXISTS commercial_acceptance_binding_guard;
CREATE TRIGGER commercial_acceptance_binding_guard
BEFORE INSERT ON commercial_acceptance_bindings
BEGIN
  SELECT RAISE(ABORT, 'commercial_lead_not_qualified')
   WHERE NOT EXISTS (
     SELECT 1
       FROM operating_roof_jobs job
       JOIN operating_leads lead
         ON lead.tenant_id = job.tenant_id AND lead.lead_id = job.lead_id
      WHERE job.tenant_id = NEW.tenant_id
        AND job.roof_job_id = NEW.roof_job_id
        AND (
          lead.lifecycle_status = 'qualified'
          OR (
            lead.lifecycle_status = 'converted'
            AND EXISTS (
              SELECT 1
                FROM commercial_quote_revisions correction_quote
               WHERE correction_quote.tenant_id = NEW.tenant_id
                 AND correction_quote.quote_revision_id = NEW.quote_revision_id
                 AND correction_quote.revision_number > 1
                 AND correction_quote.supersedes_quote_revision_id IS NOT NULL
            )
          )
        )
   );
  SELECT RAISE(ABORT, 'commercial_acceptance_chain_mismatch')
   WHERE NOT EXISTS (
     SELECT 1
       FROM customer_portal_acceptance_intents acceptance
       JOIN commercial_quote_revisions quote
         ON quote.quote_revision_id = NEW.quote_revision_id AND quote.tenant_id = NEW.tenant_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.proposal_revision_id = NEW.proposal_revision_id AND proposal.tenant_id = NEW.tenant_id
      WHERE acceptance.acceptance_id = NEW.acceptance_id
        AND acceptance.tenant_id = NEW.tenant_id
        AND acceptance.state = 'accepted'
        AND acceptance.roof_job_id = NEW.roof_job_id
        AND acceptance.customer_id = NEW.customer_id
        AND acceptance.quote_id = quote.customer_quote_id
        AND acceptance.quote_version = quote.revision_number
        AND acceptance.proposal_pack_id = proposal.proposal_pack_id
        AND acceptance.terms_hash = NEW.terms_hash
        AND acceptance.receipt_hash = NEW.receipt_hash
        AND acceptance.accepted_at = NEW.accepted_at
        AND quote.roof_job_id = NEW.roof_job_id
        AND quote.customer_id = NEW.customer_id
        AND quote.status = 'approved'
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions successor
           WHERE successor.tenant_id = quote.tenant_id
             AND successor.supersedes_quote_revision_id = quote.quote_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_quote_revisions other
           WHERE other.tenant_id = quote.tenant_id
             AND other.customer_quote_id = quote.customer_quote_id
             AND other.quote_revision_id != quote.quote_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_quote_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_quote_revision_id = other.quote_revision_id
             )
        )
        AND quote.terms_hash = NEW.terms_hash
        AND proposal.roof_job_id = NEW.roof_job_id
        AND proposal.customer_id = NEW.customer_id
        AND proposal.quote_revision_id = quote.quote_revision_id
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = proposal.tenant_id
             AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions other
           WHERE other.tenant_id = proposal.tenant_id
             AND other.proposal_pack_id = proposal.proposal_pack_id
             AND other.proposal_revision_id != proposal.proposal_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_proposal_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
             )
        )
        AND proposal.terms_hash = NEW.terms_hash
        AND EXISTS (
          SELECT 1
            FROM commercial_proposal_publication_events publication
           WHERE publication.tenant_id = NEW.tenant_id
             AND publication.proposal_pack_id = proposal.proposal_pack_id
             AND publication.proposal_revision_id = proposal.proposal_revision_id
             AND publication.state = 'published'
             AND publication.occurred_at <= acceptance.accepted_at
             AND publication.publication_version = (
               SELECT MAX(prior.publication_version)
                 FROM commercial_proposal_publication_events prior
                WHERE prior.tenant_id = NEW.tenant_id
                  AND prior.proposal_pack_id = proposal.proposal_pack_id
                  AND prior.occurred_at <= acceptance.accepted_at
             )
        )
   );
END;

CREATE TRIGGER commercial_acceptance_apply_activation_projection
AFTER INSERT ON commercial_acceptance_bindings
BEGIN
  UPDATE operating_customers
     SET lifecycle_status = 'active', version = version + 1, updated_at = NEW.bound_at
   WHERE tenant_id = NEW.tenant_id AND customer_id = NEW.customer_id
     AND lifecycle_status = 'prospect';
  UPDATE operating_leads
     SET lifecycle_status = 'converted', version = version + 1, updated_at = NEW.bound_at
   WHERE tenant_id = NEW.tenant_id
     AND lead_id = (
       SELECT lead_id FROM operating_roof_jobs
        WHERE tenant_id = NEW.tenant_id AND roof_job_id = NEW.roof_job_id
     )
     AND lifecycle_status = 'qualified';
END;

-- The queue is born from the same binding transaction.  Its source facts are only the accepted
-- intent, approved quote, exact proposal, and customer receipt; no provider/accounting field is
-- accepted from the portal request.
CREATE TRIGGER commercial_acceptance_enqueue_deposit_derivation
AFTER INSERT ON commercial_acceptance_bindings
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_source_missing')
   WHERE NOT EXISTS (
     SELECT 1
       FROM customer_portal_acceptance_intents acceptance
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = NEW.tenant_id
        AND quote.quote_revision_id = NEW.quote_revision_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.tenant_id = NEW.tenant_id
        AND proposal.proposal_revision_id = NEW.proposal_revision_id
       JOIN commercial_proposal_publication_events publication
         ON publication.tenant_id = NEW.tenant_id
        AND publication.proposal_revision_id = proposal.proposal_revision_id
        AND publication.proposal_pack_id = proposal.proposal_pack_id
      WHERE acceptance.tenant_id = NEW.tenant_id
        AND acceptance.acceptance_id = NEW.acceptance_id
        AND acceptance.state = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = proposal.tenant_id
             AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions other
           WHERE other.tenant_id = proposal.tenant_id
             AND other.proposal_pack_id = proposal.proposal_pack_id
             AND other.proposal_revision_id != proposal.proposal_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_proposal_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
             )
        )
        AND publication.publication_version = (
          SELECT MAX(current.publication_version)
            FROM commercial_proposal_publication_events current
           WHERE current.tenant_id = publication.tenant_id
             AND current.proposal_pack_id = publication.proposal_pack_id
             AND current.occurred_at <= NEW.accepted_at
        )
     AND publication.state = 'published'
     AND publication.occurred_at <= NEW.accepted_at
   );
  -- The commercial contract is an integer percentage.  SQLite's CAST would turn a browser- or
  -- legacy-supplied string/decimal/out-of-range value into a different amount, so reject the
  -- acceptance atomically before deriving any accounting basis.
  SELECT RAISE(ABORT, 'commercial_deposit_percent_invalid')
   WHERE NOT EXISTS (
     SELECT 1
       FROM commercial_quote_revisions quote
      WHERE quote.tenant_id = NEW.tenant_id
        AND quote.quote_revision_id = NEW.quote_revision_id
        AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
        AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100
   );
  INSERT INTO commercial_deposit_derivations (
    derivation_id, acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
    proposal_revision_id, proposal_version, publication_event_id, publication_version,
    roof_job_id, customer_id, customer_quote_id, quote_version,
    quote_currency, quote_subtotal_cents, quote_tax_cents, quote_total_cents, deposit_percent,
    terms_hash, receipt_hash, accepted_at, basis_json, basis_sha256, evidence_refs_json,
    command_fingerprint, idempotency_key_hash, state, intent_id, blocker_code,
    blocker_next_step, version, created_at, updated_at
  )
  SELECT
    'commercial-deposit-derivation:' || NEW.acceptance_binding_id,
    NEW.acceptance_binding_id, NEW.acceptance_id, NEW.tenant_id, NEW.quote_revision_id,
    NEW.proposal_revision_id, proposal.revision_number, publication.publication_event_id,
    publication.publication_version, NEW.roof_job_id, NEW.customer_id, quote.customer_quote_id,
    quote.revision_number, quote.currency, quote.subtotal_cents, quote.tax_cents,
    quote.total_cents, json_extract(quote.terms_json, '$.deposit_percent'),
    NEW.terms_hash, NEW.receipt_hash, NEW.accepted_at,
    json_object(
      'schema_version', 'ironwrap.commercial-deposit-basis.v1',
      'tenant_id', NEW.tenant_id,
      'acceptance_id', NEW.acceptance_id,
      'acceptance_binding_id', NEW.acceptance_binding_id,
      'quote_revision_id', NEW.quote_revision_id,
      'quote_evidence_digest', quote.evidence_digest,
      'proposal_revision_id', NEW.proposal_revision_id,
      'proposal_version', proposal.revision_number,
      'proposal_evidence_digest', proposal.evidence_digest,
      'publication_event_id', publication.publication_event_id,
      'publication_version', publication.publication_version,
      'publication_evidence_digest', publication.evidence_digest,
      'roof_job_id', NEW.roof_job_id,
      'customer_id', NEW.customer_id,
      'customer_quote_id', quote.customer_quote_id,
      'quote_version', quote.revision_number,
      'quote_currency', quote.currency,
      'quote_subtotal_cents', quote.subtotal_cents,
      'quote_tax_cents', quote.tax_cents,
      'quote_total_cents', quote.total_cents,
      'deposit_percent', json_extract(quote.terms_json, '$.deposit_percent'),
      'terms_hash', NEW.terms_hash,
      'receipt_hash', NEW.receipt_hash,
      'accepted_at', NEW.accepted_at
    ),
    NULL,
    json_array(
      json_object('ref', 'd1://commercial_acceptance_bindings/' || NEW.acceptance_binding_id,
                  'sha256', NEW.receipt_hash),
      json_object('ref', 'd1://commercial_quote_revisions/' || NEW.quote_revision_id,
                  'sha256', quote.evidence_digest),
      json_object('ref', 'd1://commercial_proposal_revisions/' || NEW.proposal_revision_id,
                  'sha256', proposal.evidence_digest),
      json_object('ref', 'd1://commercial_proposal_publication_events/' || publication.publication_event_id,
                  'sha256', publication.evidence_digest)
    ),
    acceptance.request_fingerprint, acceptance.idempotency_key_hash, 'pending', NULL, NULL,
    NULL, 1, NEW.bound_at, NEW.bound_at
  FROM customer_portal_acceptance_intents acceptance
  JOIN commercial_quote_revisions quote
    ON quote.tenant_id = NEW.tenant_id AND quote.quote_revision_id = NEW.quote_revision_id
  JOIN commercial_proposal_revisions proposal
    ON proposal.tenant_id = NEW.tenant_id
   AND proposal.proposal_revision_id = NEW.proposal_revision_id
  JOIN commercial_proposal_publication_events publication
    ON publication.tenant_id = NEW.tenant_id
   AND publication.proposal_revision_id = proposal.proposal_revision_id
   AND publication.proposal_pack_id = proposal.proposal_pack_id
  WHERE acceptance.tenant_id = NEW.tenant_id AND acceptance.acceptance_id = NEW.acceptance_id
    AND acceptance.state = 'accepted'
    AND NOT EXISTS (
      SELECT 1 FROM commercial_proposal_revisions successor
       WHERE successor.tenant_id = proposal.tenant_id
         AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM commercial_proposal_revisions other
       WHERE other.tenant_id = proposal.tenant_id
         AND other.proposal_pack_id = proposal.proposal_pack_id
         AND other.proposal_revision_id != proposal.proposal_revision_id
         AND NOT EXISTS (
           SELECT 1 FROM commercial_proposal_revisions other_successor
            WHERE other_successor.tenant_id = other.tenant_id
              AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
         )
    )
    AND publication.publication_version = (
      SELECT MAX(current.publication_version)
        FROM commercial_proposal_publication_events current
       WHERE current.tenant_id = publication.tenant_id
         AND current.proposal_pack_id = publication.proposal_pack_id
         AND current.occurred_at <= NEW.accepted_at
    )
    AND publication.state = 'published'
    AND publication.occurred_at <= NEW.accepted_at;
END;

-- 0093 shipped the binding before the native activation/deposit projections existed.  Replay the
-- exact accepted facts for those bindings during upgrade; fresh installs are a no-op because the
-- AFTER INSERT trigger above already created the unique queue row.  Invalid legacy commercial
-- terms deliberately violate the deposit_percent CHECK and stop the migration instead of silently
-- leaving an accepted contract without its accounting handoff.
INSERT INTO commercial_deposit_derivations (
  derivation_id, acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
  proposal_revision_id, proposal_version, publication_event_id, publication_version,
  roof_job_id, customer_id, customer_quote_id, quote_version,
  quote_currency, quote_subtotal_cents, quote_tax_cents, quote_total_cents, deposit_percent,
  terms_hash, receipt_hash, accepted_at, basis_json, basis_sha256, evidence_refs_json,
  command_fingerprint, idempotency_key_hash, state, intent_id, blocker_code,
  blocker_next_step, version, created_at, updated_at
)
SELECT
  'commercial-deposit-derivation:' || binding.acceptance_binding_id,
  binding.acceptance_binding_id, binding.acceptance_id, binding.tenant_id,
  binding.quote_revision_id, binding.proposal_revision_id, proposal.revision_number,
  publication.publication_event_id, publication.publication_version,
  binding.roof_job_id, binding.customer_id, quote.customer_quote_id, quote.revision_number,
  quote.currency, quote.subtotal_cents, quote.tax_cents, quote.total_cents,
  CASE
    WHEN quote.status = 'approved'
     AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
     AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100
    THEN json_extract(quote.terms_json, '$.deposit_percent')
    ELSE -1
  END,
  binding.terms_hash, binding.receipt_hash, binding.accepted_at,
  json_object(
    'schema_version', 'ironwrap.commercial-deposit-basis.v1',
    'tenant_id', binding.tenant_id,
    'acceptance_id', binding.acceptance_id,
    'acceptance_binding_id', binding.acceptance_binding_id,
    'quote_revision_id', binding.quote_revision_id,
    'quote_evidence_digest', quote.evidence_digest,
    'proposal_revision_id', binding.proposal_revision_id,
    'proposal_version', proposal.revision_number,
    'proposal_evidence_digest', proposal.evidence_digest,
    'publication_event_id', publication.publication_event_id,
    'publication_version', publication.publication_version,
    'publication_evidence_digest', publication.evidence_digest,
    'roof_job_id', binding.roof_job_id,
    'customer_id', binding.customer_id,
    'customer_quote_id', quote.customer_quote_id,
    'quote_version', quote.revision_number,
    'quote_currency', quote.currency,
    'quote_subtotal_cents', quote.subtotal_cents,
    'quote_tax_cents', quote.tax_cents,
    'quote_total_cents', quote.total_cents,
    'deposit_percent', json_extract(quote.terms_json, '$.deposit_percent'),
    'terms_hash', binding.terms_hash,
    'receipt_hash', binding.receipt_hash,
    'accepted_at', binding.accepted_at
  ),
  NULL,
  json_array(
    json_object('ref', 'd1://commercial_acceptance_bindings/' || binding.acceptance_binding_id,
                'sha256', binding.receipt_hash),
    json_object('ref', 'd1://commercial_quote_revisions/' || binding.quote_revision_id,
                'sha256', quote.evidence_digest),
    json_object('ref', 'd1://commercial_proposal_revisions/' || binding.proposal_revision_id,
                'sha256', proposal.evidence_digest),
    json_object('ref', 'd1://commercial_proposal_publication_events/' || publication.publication_event_id,
                'sha256', publication.evidence_digest)
  ),
  acceptance.request_fingerprint, acceptance.idempotency_key_hash,
  'pending', NULL, NULL, NULL, 1, binding.bound_at, binding.bound_at
FROM commercial_acceptance_bindings binding
JOIN customer_portal_acceptance_intents acceptance
  ON acceptance.tenant_id = binding.tenant_id
 AND acceptance.acceptance_id = binding.acceptance_id
 AND acceptance.state = 'accepted'
JOIN commercial_quote_revisions quote
  ON quote.tenant_id = binding.tenant_id
 AND quote.quote_revision_id = binding.quote_revision_id
JOIN commercial_proposal_revisions proposal
  ON proposal.tenant_id = binding.tenant_id
 AND proposal.proposal_revision_id = binding.proposal_revision_id
 AND proposal.quote_revision_id = quote.quote_revision_id
JOIN commercial_proposal_publication_events publication
  ON publication.tenant_id = binding.tenant_id
 AND publication.proposal_pack_id = proposal.proposal_pack_id
 AND publication.proposal_revision_id = proposal.proposal_revision_id
 AND publication.state = 'published'
 AND publication.occurred_at <= binding.accepted_at
 AND publication.publication_version = (
   SELECT MAX(prior.publication_version)
     FROM commercial_proposal_publication_events prior
    WHERE prior.tenant_id = binding.tenant_id
      AND prior.proposal_pack_id = proposal.proposal_pack_id
      AND prior.occurred_at <= binding.accepted_at
 )
WHERE NOT EXISTS (
  SELECT 1 FROM commercial_deposit_derivations existing
   WHERE existing.tenant_id = binding.tenant_id
     AND existing.acceptance_binding_id = binding.acceptance_binding_id
);

UPDATE operating_customers
   SET lifecycle_status = 'active',
       version = version + 1,
       updated_at = (
         SELECT MAX(binding.bound_at)
           FROM commercial_acceptance_bindings binding
          WHERE binding.tenant_id = operating_customers.tenant_id
            AND binding.customer_id = operating_customers.customer_id
       )
 WHERE lifecycle_status = 'prospect'
   AND EXISTS (
     SELECT 1 FROM commercial_acceptance_bindings binding
      WHERE binding.tenant_id = operating_customers.tenant_id
        AND binding.customer_id = operating_customers.customer_id
   );

UPDATE operating_leads
   SET lifecycle_status = 'converted',
       version = version + 1,
       updated_at = (
         SELECT MAX(binding.bound_at)
           FROM commercial_acceptance_bindings binding
           JOIN operating_roof_jobs job
             ON job.tenant_id = binding.tenant_id
            AND job.roof_job_id = binding.roof_job_id
          WHERE job.tenant_id = operating_leads.tenant_id
            AND job.lead_id = operating_leads.lead_id
       )
 WHERE lifecycle_status = 'qualified'
   AND EXISTS (
     SELECT 1
       FROM commercial_acceptance_bindings binding
       JOIN operating_roof_jobs job
         ON job.tenant_id = binding.tenant_id
        AND job.roof_job_id = binding.roof_job_id
      WHERE job.tenant_id = operating_leads.tenant_id
        AND job.lead_id = operating_leads.lead_id
   );
