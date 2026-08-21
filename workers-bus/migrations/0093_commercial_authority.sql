-- 0093_commercial_authority.sql - tenant-owned, Frappe-free commercial facts.
--
-- Commercial decisions are immutable revisions. Short-lived policy permits are admitted from
-- server-owned policy configuration; the existing approval ledgers remain a compatible alternate
-- authority. Customer-visible publication still requires either a succeeded external effect or
-- an already executed proposal-publication approval. Customer acceptance reuses the existing
-- email-verified acceptance intent and receipt chain.

CREATE TABLE IF NOT EXISTS commercial_authority_permits (
  permit_id TEXT PRIMARY KEY CHECK (
    length(permit_id) BETWEEN 32 AND 120
    AND permit_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  policy_id TEXT NOT NULL CHECK (
    length(policy_id) BETWEEN 3 AND 120
    AND policy_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  policy_version TEXT NOT NULL CHECK (
    length(policy_version) BETWEEN 2 AND 32
    AND policy_version GLOB 'v[1-9]*'
  ),
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9a-f]*'
  ),
  policy_snapshot_json TEXT NOT NULL CHECK (
    length(policy_snapshot_json) BETWEEN 2 AND 32768 AND json_valid(policy_snapshot_json)
  ),
  action TEXT NOT NULL CHECK (action IN (
    'lead.triage.record',
    'quote.revision.record',
    'proposal.revision.record',
    'proposal.publish',
    'proposal.withdraw'
  )),
  actor_type TEXT NOT NULL CHECK (
    actor_type IN ('agent', 'worker', 'customer', 'external_authority', 'device', 'owner')
  ),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) BETWEEN 1 AND 160),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN (
    'lead', 'customer_quote', 'proposal', 'proposal_publication'
  )),
  aggregate_id TEXT NOT NULL CHECK (
    length(aggregate_id) BETWEEN 8 AND 200
    AND aggregate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  aggregate_version INTEGER NOT NULL CHECK (aggregate_version BETWEEN 1 AND 1000000),
  amount_cents INTEGER CHECK (
    amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 0 AND 1000000000000)
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  facts_digest TEXT NOT NULL CHECK (
    length(facts_digest) = 64 AND facts_digest NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL CHECK (length(issued_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40),
  CHECK (expires_at > issued_at),
  UNIQUE (permit_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_commercial_permits_tenant_expiry
  ON commercial_authority_permits (tenant_id, action, expires_at);
CREATE INDEX IF NOT EXISTS idx_commercial_permits_aggregate
  ON commercial_authority_permits (tenant_id, aggregate_type, aggregate_id, aggregate_version);

CREATE TABLE IF NOT EXISTS commercial_lead_triage_decisions (
  triage_decision_id TEXT PRIMARY KEY CHECK (
    length(triage_decision_id) BETWEEN 20 AND 120
    AND triage_decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  lead_id TEXT NOT NULL,
  lead_version INTEGER NOT NULL CHECK (lead_version BETWEEN 2 AND 1000000),
  lifecycle_status TEXT NOT NULL CHECK (
    lifecycle_status IN ('triaged', 'qualified', 'disqualified')
  ),
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  category TEXT NOT NULL CHECK (length(trim(category)) BETWEEN 2 AND 80),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 2000),
  next_action TEXT NOT NULL CHECK (length(trim(next_action)) BETWEEN 1 AND 500),
  policy_permit_id TEXT,
  lead_triage_approval_id TEXT,
  authority_evidence_digest TEXT NOT NULL CHECK (
    length(authority_evidence_digest) = 64 AND authority_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  decided_at TEXT NOT NULL CHECK (length(decided_at) BETWEEN 20 AND 40),
  CHECK ((policy_permit_id IS NOT NULL) != (lead_triage_approval_id IS NOT NULL)),
  UNIQUE (triage_decision_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, lead_id, lead_version),
  FOREIGN KEY (lead_id, tenant_id)
    REFERENCES operating_leads(lead_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_permit_id, tenant_id)
    REFERENCES commercial_authority_permits(permit_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (lead_triage_approval_id, tenant_id)
    REFERENCES approval_requests(approval_request_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_triage_lead
  ON commercial_lead_triage_decisions (tenant_id, lead_id, lead_version DESC);

CREATE TABLE IF NOT EXISTS commercial_quote_revisions (
  quote_revision_id TEXT PRIMARY KEY CHECK (
    length(quote_revision_id) BETWEEN 12 AND 160
    AND quote_revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  customer_quote_id TEXT NOT NULL CHECK (
    length(customer_quote_id) BETWEEN 8 AND 160
    AND customer_quote_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 1000000),
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  supersedes_quote_revision_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('draft', 'needs_review', 'approved', 'rejected', 'expired')
  ),
  currency TEXT NOT NULL CHECK (
    length(currency) = 3 AND currency = upper(currency)
    AND currency NOT GLOB '*[^A-Z]*'
  ),
  valid_until TEXT NOT NULL CHECK (length(valid_until) = 10),
  subtotal_cents INTEGER NOT NULL CHECK (
    typeof(subtotal_cents) = 'integer' AND subtotal_cents BETWEEN 0 AND 1000000000000
  ),
  tax_cents INTEGER NOT NULL CHECK (
    typeof(tax_cents) = 'integer' AND tax_cents BETWEEN 0 AND 1000000000000
  ),
  total_cents INTEGER NOT NULL CHECK (
    typeof(total_cents) = 'integer' AND total_cents BETWEEN 0 AND 1000000000000
  ),
  terms_json TEXT NOT NULL CHECK (
    length(terms_json) BETWEEN 2 AND 48000 AND json_valid(terms_json)
  ),
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  correction_reason TEXT,
  policy_permit_id TEXT,
  quote_revision_approval_id TEXT,
  authority_evidence_digest TEXT NOT NULL CHECK (
    length(authority_evidence_digest) = 64 AND authority_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (total_cents = subtotal_cents + tax_cents),
  CHECK (
    (revision_number = 1 AND supersedes_quote_revision_id IS NULL AND correction_reason IS NULL)
    OR (revision_number > 1 AND supersedes_quote_revision_id IS NOT NULL
      AND length(trim(correction_reason)) BETWEEN 3 AND 2000)
  ),
  CHECK ((policy_permit_id IS NOT NULL) != (quote_revision_approval_id IS NOT NULL)),
  UNIQUE (quote_revision_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, customer_quote_id, revision_number),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id)
    REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_permit_id, tenant_id)
    REFERENCES commercial_authority_permits(permit_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (quote_revision_approval_id, tenant_id)
    REFERENCES quote_revision_approval_requests(quote_revision_approval_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_quotes_job
  ON commercial_quote_revisions (tenant_id, roof_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_quotes_current
  ON commercial_quote_revisions (tenant_id, customer_quote_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS commercial_quote_lines (
  quote_revision_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  line_id TEXT NOT NULL CHECK (
    length(line_id) BETWEEN 3 AND 120 AND line_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
  kind TEXT NOT NULL CHECK (kind IN (
    'material', 'labour', 'equipment', 'subcontract', 'allowance', 'discount', 'other'
  )),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  quantity_micros INTEGER NOT NULL CHECK (
    typeof(quantity_micros) = 'integer' AND quantity_micros BETWEEN 1 AND 1000000000000
  ),
  uom TEXT NOT NULL CHECK (length(trim(uom)) BETWEEN 1 AND 32),
  unit_price_cents INTEGER NOT NULL CHECK (
    typeof(unit_price_cents) = 'integer' AND unit_price_cents BETWEEN -1000000000000 AND 1000000000000
  ),
  subtotal_cents INTEGER NOT NULL CHECK (
    typeof(subtotal_cents) = 'integer' AND subtotal_cents BETWEEN -1000000000000 AND 1000000000000
  ),
  tax_code TEXT CHECK (tax_code IS NULL OR length(trim(tax_code)) BETWEEN 1 AND 40),
  tax_cents INTEGER NOT NULL CHECK (
    typeof(tax_cents) = 'integer' AND tax_cents BETWEEN -1000000000000 AND 1000000000000
  ),
  total_cents INTEGER NOT NULL CHECK (
    typeof(total_cents) = 'integer' AND total_cents BETWEEN -1000000000000 AND 1000000000000
  ),
  CHECK (total_cents = subtotal_cents + tax_cents),
  CHECK (kind = 'discount' OR (unit_price_cents >= 0 AND subtotal_cents >= 0 AND tax_cents >= 0)),
  PRIMARY KEY (quote_revision_id, line_id),
  UNIQUE (quote_revision_id, sequence),
  FOREIGN KEY (quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_quote_lines_sequence
  ON commercial_quote_lines (quote_revision_id, sequence);

CREATE TABLE IF NOT EXISTS commercial_proposal_revisions (
  proposal_revision_id TEXT PRIMARY KEY CHECK (
    length(proposal_revision_id) BETWEEN 12 AND 160
    AND proposal_revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  proposal_pack_id TEXT NOT NULL CHECK (
    length(proposal_pack_id) BETWEEN 8 AND 160
    AND proposal_pack_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 1000000),
  quote_revision_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  supersedes_proposal_revision_id TEXT,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 4000),
  terms_json TEXT NOT NULL CHECK (
    length(terms_json) BETWEEN 2 AND 48000 AND json_valid(terms_json)
  ),
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  content_ref TEXT NOT NULL CHECK (
    length(content_ref) BETWEEN 3 AND 512
    AND content_ref NOT GLOB '*[?#]*'
    AND instr(content_ref, '..') = 0
  ),
  content_hash TEXT NOT NULL CHECK (
    length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_refs_json TEXT NOT NULL CHECK (
    length(evidence_refs_json) BETWEEN 2 AND 32768 AND json_valid(evidence_refs_json)
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  policy_permit_id TEXT NOT NULL,
  authority_evidence_digest TEXT NOT NULL CHECK (
    length(authority_evidence_digest) = 64 AND authority_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  CHECK (
    (revision_number = 1 AND supersedes_proposal_revision_id IS NULL)
    OR (revision_number > 1 AND supersedes_proposal_revision_id IS NOT NULL)
  ),
  UNIQUE (proposal_revision_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, proposal_pack_id, revision_number),
  FOREIGN KEY (quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id)
    REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_proposal_revision_id, tenant_id)
    REFERENCES commercial_proposal_revisions(proposal_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_permit_id, tenant_id)
    REFERENCES commercial_authority_permits(permit_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_proposals_job
  ON commercial_proposal_revisions (tenant_id, roof_job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_proposals_current
  ON commercial_proposal_revisions (tenant_id, proposal_pack_id, revision_number DESC);

CREATE TABLE IF NOT EXISTS commercial_proposal_publication_events (
  publication_event_id TEXT PRIMARY KEY CHECK (
    length(publication_event_id) BETWEEN 20 AND 120
    AND publication_event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  proposal_revision_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL,
  publication_version INTEGER NOT NULL CHECK (publication_version BETWEEN 1 AND 1000000),
  previous_state TEXT NOT NULL CHECK (previous_state IN ('draft', 'published', 'withdrawn')),
  state TEXT NOT NULL CHECK (state IN ('published', 'withdrawn')),
  policy_permit_id TEXT,
  proposal_publication_approval_id TEXT,
  external_effect_id TEXT,
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  CHECK (
    (previous_state = 'draft' AND state = 'published')
    OR (previous_state = 'published' AND state = 'withdrawn')
    OR (previous_state = 'withdrawn' AND state = 'published')
  ),
  CHECK (
    (policy_permit_id IS NOT NULL AND proposal_publication_approval_id IS NULL AND external_effect_id IS NOT NULL)
    OR (policy_permit_id IS NULL AND proposal_publication_approval_id IS NOT NULL AND external_effect_id IS NULL)
  ),
  UNIQUE (publication_event_id, tenant_id),
  UNIQUE (tenant_id, idempotency_key_hash),
  UNIQUE (tenant_id, proposal_pack_id, publication_version),
  FOREIGN KEY (proposal_revision_id, tenant_id)
    REFERENCES commercial_proposal_revisions(proposal_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_permit_id, tenant_id)
    REFERENCES commercial_authority_permits(permit_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_publication_approval_id, tenant_id)
    REFERENCES proposal_publication_approval_requests(proposal_publication_approval_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (external_effect_id)
    REFERENCES external_effects(effect_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_publications_current
  ON commercial_proposal_publication_events (tenant_id, proposal_pack_id, publication_version DESC);
CREATE INDEX IF NOT EXISTS idx_commercial_publications_effect
  ON commercial_proposal_publication_events (external_effect_id);

CREATE TABLE IF NOT EXISTS commercial_acceptance_bindings (
  acceptance_binding_id TEXT PRIMARY KEY CHECK (
    length(acceptance_binding_id) BETWEEN 24 AND 120
    AND acceptance_binding_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  acceptance_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  quote_revision_id TEXT NOT NULL,
  proposal_revision_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  terms_hash TEXT NOT NULL CHECK (
    length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*'
  ),
  receipt_hash TEXT NOT NULL CHECK (
    length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_at TEXT NOT NULL CHECK (length(accepted_at) BETWEEN 20 AND 40),
  bound_at TEXT NOT NULL CHECK (length(bound_at) BETWEEN 20 AND 40 AND bound_at >= accepted_at),
  UNIQUE (acceptance_binding_id, tenant_id),
  FOREIGN KEY (acceptance_id)
    REFERENCES customer_portal_acceptance_intents(acceptance_id) ON DELETE RESTRICT,
  FOREIGN KEY (quote_revision_id, tenant_id)
    REFERENCES commercial_quote_revisions(quote_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (proposal_revision_id, tenant_id)
    REFERENCES commercial_proposal_revisions(proposal_revision_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id)
    REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_commercial_acceptances_job
  ON commercial_acceptance_bindings (tenant_id, roof_job_id, accepted_at DESC);

-- SQLite REPLACE resolves a uniqueness collision by deleting the retained row before inserting
-- the replacement. UPDATE/DELETE guards do not observe that implicit delete unless recursive
-- triggers are enabled, so every real primary/unique identity needs an explicit insert guard.
CREATE TRIGGER IF NOT EXISTS commercial_authority_permits_no_insert_replace
BEFORE INSERT ON commercial_authority_permits BEGIN
  SELECT RAISE(ABORT, 'commercial_authority_permits_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_authority_permits permit
     WHERE permit.permit_id = NEW.permit_id
        OR (permit.tenant_id = NEW.tenant_id
            AND permit.idempotency_key_hash = NEW.idempotency_key_hash)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_triage_decisions_no_insert_replace
BEFORE INSERT ON commercial_lead_triage_decisions BEGIN
  SELECT RAISE(ABORT, 'commercial_triage_decisions_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_lead_triage_decisions decision
     WHERE decision.triage_decision_id = NEW.triage_decision_id
        OR (decision.tenant_id = NEW.tenant_id
            AND decision.idempotency_key_hash = NEW.idempotency_key_hash)
        OR (decision.tenant_id = NEW.tenant_id
            AND decision.lead_id = NEW.lead_id
            AND decision.lead_version = NEW.lead_version)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_quote_revisions_no_insert_replace
BEFORE INSERT ON commercial_quote_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_revisions_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_quote_revisions quote
     WHERE quote.quote_revision_id = NEW.quote_revision_id
        OR (quote.tenant_id = NEW.tenant_id
            AND quote.idempotency_key_hash = NEW.idempotency_key_hash)
        OR (quote.tenant_id = NEW.tenant_id
            AND quote.customer_quote_id = NEW.customer_quote_id
            AND quote.revision_number = NEW.revision_number)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_quote_lines_no_insert_replace
BEFORE INSERT ON commercial_quote_lines BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_lines_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_quote_lines line
     WHERE (line.quote_revision_id = NEW.quote_revision_id AND line.line_id = NEW.line_id)
        OR (line.quote_revision_id = NEW.quote_revision_id AND line.sequence = NEW.sequence)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_proposal_revisions_no_insert_replace
BEFORE INSERT ON commercial_proposal_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_revisions_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_proposal_revisions proposal
     WHERE proposal.proposal_revision_id = NEW.proposal_revision_id
        OR (proposal.tenant_id = NEW.tenant_id
            AND proposal.idempotency_key_hash = NEW.idempotency_key_hash)
        OR (proposal.tenant_id = NEW.tenant_id
            AND proposal.proposal_pack_id = NEW.proposal_pack_id
            AND proposal.revision_number = NEW.revision_number)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_publication_events_no_insert_replace
BEFORE INSERT ON commercial_proposal_publication_events BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_events_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_proposal_publication_events publication
     WHERE publication.publication_event_id = NEW.publication_event_id
        OR (publication.tenant_id = NEW.tenant_id
            AND publication.idempotency_key_hash = NEW.idempotency_key_hash)
        OR (publication.tenant_id = NEW.tenant_id
            AND publication.proposal_pack_id = NEW.proposal_pack_id
            AND publication.publication_version = NEW.publication_version)
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_acceptance_bindings_no_insert_replace
BEFORE INSERT ON commercial_acceptance_bindings BEGIN
  SELECT RAISE(ABORT, 'commercial_acceptance_bindings_append_only') WHERE EXISTS (
    SELECT 1 FROM commercial_acceptance_bindings binding
     WHERE binding.acceptance_binding_id = NEW.acceptance_binding_id
        OR binding.acceptance_id = NEW.acceptance_id
  );
END;

-- Commercial permits use the shared provider-neutral effect ledger, but remain one-command,
-- one-effect capabilities. Retries/reconciliation update the same effect; a second effect ID under
-- the same permit would be a second externally visible action and is refused.
CREATE TRIGGER IF NOT EXISTS commercial_external_effect_authority_guard
BEFORE INSERT ON external_effects
WHEN EXISTS (
  SELECT 1 FROM commercial_authority_permits permit WHERE permit.permit_id = NEW.authority_ref
)
BEGIN
  SELECT RAISE(ABORT, 'commercial_external_effect_authority_mismatch') WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_authority_permits permit
      JOIN commercial_proposal_revisions proposal
        ON proposal.proposal_revision_id = NEW.intent_id
       AND proposal.tenant_id = NEW.tenant_id
       AND proposal.proposal_pack_id = NEW.aggregate_id
     WHERE permit.permit_id = NEW.authority_ref
       AND permit.tenant_id = NEW.tenant_id
       AND permit.policy_id = NEW.policy_ref
       AND permit.policy_version = NEW.policy_version
       AND permit.actor_type = NEW.actor_type
       AND permit.actor_id = NEW.actor_id
       AND permit.action IN ('proposal.publish', 'proposal.withdraw')
       AND permit.action = NEW.action
       AND permit.aggregate_type = 'proposal_publication'
       AND permit.aggregate_type = NEW.aggregate_type
       AND permit.aggregate_id = NEW.aggregate_id
       AND permit.aggregate_version = NEW.aggregate_version
       AND permit.issued_at <= NEW.created_at
       AND permit.expires_at > NEW.created_at
  );
  SELECT RAISE(ABORT, 'commercial_external_effect_permit_reused') WHERE EXISTS (
    SELECT 1 FROM external_effects effect WHERE effect.authority_ref = NEW.authority_ref
  );
END;

-- Authority bindings are checked again at the database boundary. This keeps future callers from
-- attaching an unrelated permit or a non-terminal legacy approval to an immutable decision.
CREATE TRIGGER IF NOT EXISTS commercial_triage_authority_guard
BEFORE INSERT ON commercial_lead_triage_decisions
BEGIN
  SELECT RAISE(ABORT, 'commercial_triage_authority_mismatch')
   WHERE NEW.policy_permit_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM commercial_authority_permits permit
      WHERE permit.permit_id = NEW.policy_permit_id
        AND permit.tenant_id = NEW.tenant_id
        AND permit.action = 'lead.triage.record'
        AND permit.aggregate_type = 'lead'
        AND permit.aggregate_id = NEW.lead_id
        AND permit.aggregate_version = NEW.lead_version - 1
        AND permit.command_fingerprint = NEW.command_fingerprint
        AND permit.evidence_digest = NEW.authority_evidence_digest
        AND permit.issued_at <= NEW.decided_at
        AND permit.expires_at > NEW.decided_at
   );
  SELECT RAISE(ABORT, 'commercial_triage_approval_mismatch')
   WHERE NEW.lead_triage_approval_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM approval_requests approval
       JOIN operating_leads lead
         ON lead.lead_id = NEW.lead_id AND lead.tenant_id = NEW.tenant_id
      WHERE approval.approval_request_id = NEW.lead_triage_approval_id
        AND approval.tenant_id = NEW.tenant_id
        AND approval.lead_envelope_id = lead.source_envelope_id
        AND approval.args_digest = NEW.authority_evidence_digest
        AND approval.approved_by_user_id IS NOT NULL
        AND (
          approval.state = 'executed'
          OR (approval.state = 'execution_uncertain'
            AND approval.reconciliation_outcome = 'executed'
            AND length(approval.reconciliation_evidence) >= 3)
        )
   );
END;

CREATE TRIGGER IF NOT EXISTS commercial_quote_authority_guard
BEFORE INSERT ON commercial_quote_revisions
BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_authority_mismatch')
   WHERE NEW.policy_permit_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM commercial_authority_permits permit
      WHERE permit.permit_id = NEW.policy_permit_id
        AND permit.tenant_id = NEW.tenant_id
        AND permit.action = 'quote.revision.record'
        AND permit.aggregate_type = 'customer_quote'
        AND permit.aggregate_id = NEW.customer_quote_id
        AND permit.aggregate_version = NEW.revision_number
        AND permit.amount_cents = NEW.total_cents
        AND permit.command_fingerprint = NEW.command_fingerprint
        AND permit.evidence_digest = NEW.authority_evidence_digest
        AND permit.issued_at <= NEW.created_at
        AND permit.expires_at > NEW.created_at
   );
  SELECT RAISE(ABORT, 'commercial_quote_approval_mismatch')
   WHERE NEW.quote_revision_approval_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM quote_revision_approval_requests approval
      WHERE approval.quote_revision_approval_id = NEW.quote_revision_approval_id
        AND approval.tenant_id = NEW.tenant_id
        AND approval.target_customer_quote_id = NEW.customer_quote_id
        AND approval.target_quote_version = NEW.revision_number
        AND approval.roof_job_id = NEW.roof_job_id
        AND approval.args_digest = NEW.authority_evidence_digest
        AND approval.approved_by_user_id IS NOT NULL
        AND (
          approval.state = 'executed'
          OR (approval.state = 'execution_uncertain'
            AND approval.reconciliation_outcome = 'executed'
            AND length(approval.reconciliation_evidence) >= 3)
        )
   );
END;

CREATE TRIGGER IF NOT EXISTS commercial_proposal_authority_guard
BEFORE INSERT ON commercial_proposal_revisions
BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_authority_mismatch') WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_authority_permits permit
     WHERE permit.permit_id = NEW.policy_permit_id
       AND permit.tenant_id = NEW.tenant_id
       AND permit.action = 'proposal.revision.record'
       AND permit.aggregate_type = 'proposal'
       AND permit.aggregate_id = NEW.proposal_pack_id
       AND permit.aggregate_version = NEW.revision_number
       AND permit.command_fingerprint = NEW.command_fingerprint
       AND permit.evidence_digest = NEW.authority_evidence_digest
       AND permit.issued_at <= NEW.created_at
       AND permit.expires_at > NEW.created_at
  );
  SELECT RAISE(ABORT, 'commercial_proposal_quote_mismatch') WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_quote_revisions quote
     WHERE quote.quote_revision_id = NEW.quote_revision_id
       AND quote.tenant_id = NEW.tenant_id
       AND quote.status = 'approved'
       AND quote.roof_job_id = NEW.roof_job_id
       AND quote.customer_id = NEW.customer_id
       AND quote.terms_hash = NEW.terms_hash
  );
END;

CREATE TRIGGER IF NOT EXISTS commercial_publication_authority_guard
BEFORE INSERT ON commercial_proposal_publication_events
BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_proposal_mismatch') WHERE NOT EXISTS (
    SELECT 1 FROM commercial_proposal_revisions proposal
     WHERE proposal.proposal_revision_id = NEW.proposal_revision_id
       AND proposal.tenant_id = NEW.tenant_id
       AND proposal.proposal_pack_id = NEW.proposal_pack_id
  );
  SELECT RAISE(ABORT, 'commercial_publication_authority_mismatch')
   WHERE NEW.policy_permit_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM commercial_authority_permits permit
       JOIN external_effects effect ON effect.effect_id = NEW.external_effect_id
      WHERE permit.permit_id = NEW.policy_permit_id
        AND permit.tenant_id = NEW.tenant_id
        AND permit.action = CASE NEW.state
          WHEN 'published' THEN 'proposal.publish' ELSE 'proposal.withdraw' END
        AND permit.aggregate_type = 'proposal_publication'
        AND permit.aggregate_id = NEW.proposal_pack_id
        AND permit.aggregate_version = NEW.publication_version
        AND permit.command_fingerprint = NEW.command_fingerprint
        AND permit.evidence_digest = NEW.evidence_digest
        AND permit.issued_at <= NEW.occurred_at
        AND permit.expires_at > NEW.occurred_at
        AND effect.tenant_id = NEW.tenant_id
        AND effect.state = 'succeeded'
        AND effect.intent_id = NEW.proposal_revision_id
        AND effect.authority_ref = permit.permit_id
        AND effect.policy_ref = permit.policy_id
        AND effect.policy_version = permit.policy_version
        AND effect.actor_type = permit.actor_type
        AND effect.actor_id = permit.actor_id
        AND effect.aggregate_type = 'proposal_publication'
        AND effect.aggregate_id = NEW.proposal_pack_id
        AND effect.aggregate_version = NEW.publication_version
        AND effect.action = permit.action
   );
  SELECT RAISE(ABORT, 'commercial_publication_approval_mismatch')
   WHERE NEW.proposal_publication_approval_id IS NOT NULL AND NOT EXISTS (
     SELECT 1
       FROM proposal_publication_approval_requests approval
       JOIN commercial_proposal_revisions proposal
         ON proposal.proposal_revision_id = NEW.proposal_revision_id
        AND proposal.tenant_id = NEW.tenant_id
       JOIN commercial_quote_revisions quote
         ON quote.quote_revision_id = proposal.quote_revision_id
        AND quote.tenant_id = NEW.tenant_id
      WHERE NEW.state = 'published'
        AND approval.proposal_publication_approval_id = NEW.proposal_publication_approval_id
        AND approval.tenant_id = NEW.tenant_id
        AND approval.proposal_evidence_pack_id = NEW.proposal_pack_id
        AND approval.customer_quote_id = quote.customer_quote_id
        AND approval.roof_job_id = proposal.roof_job_id
        AND approval.args_digest = NEW.evidence_digest
        AND approval.approved_by_user_id IS NOT NULL
        AND (
          approval.state = 'executed'
          OR (approval.state = 'execution_uncertain'
            AND approval.reconciliation_outcome = 'executed'
            AND length(approval.reconciliation_evidence) >= 3)
        )
   );
END;

-- The decision and the current lead projection are committed in one SQLite transaction. A stale
-- aggregate version or illegal lifecycle reversal aborts the inserted decision too.
CREATE TRIGGER IF NOT EXISTS commercial_triage_apply_projection
AFTER INSERT ON commercial_lead_triage_decisions
BEGIN
  UPDATE operating_leads
     SET lifecycle_status = NEW.lifecycle_status,
         version = version + 1,
         updated_at = NEW.decided_at
   WHERE tenant_id = NEW.tenant_id
     AND lead_id = NEW.lead_id
     AND version = NEW.lead_version - 1
     AND (
       (lifecycle_status = 'untriaged' AND NEW.lifecycle_status IN ('triaged', 'qualified', 'disqualified'))
       OR (lifecycle_status = 'triaged' AND NEW.lifecycle_status IN ('qualified', 'disqualified'))
     );
  SELECT RAISE(ABORT, 'commercial_triage_version_or_transition_conflict') WHERE changes() != 1;
END;

CREATE TRIGGER IF NOT EXISTS commercial_quote_revision_sequence_guard
BEFORE INSERT ON commercial_quote_revisions
BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_revision_sequence_conflict')
   WHERE NEW.revision_number != COALESCE((
     SELECT MAX(revision_number) + 1
       FROM commercial_quote_revisions
      WHERE tenant_id = NEW.tenant_id AND customer_quote_id = NEW.customer_quote_id
   ), 1);
  SELECT RAISE(ABORT, 'commercial_quote_revision_predecessor_conflict')
   WHERE NEW.supersedes_quote_revision_id IS NOT (
     SELECT quote_revision_id
       FROM commercial_quote_revisions
      WHERE tenant_id = NEW.tenant_id AND customer_quote_id = NEW.customer_quote_id
      ORDER BY revision_number DESC LIMIT 1
   );
  SELECT RAISE(ABORT, 'commercial_quote_identity_conflict')
   WHERE NEW.revision_number > 1 AND NOT EXISTS (
     SELECT 1
       FROM commercial_quote_revisions prior
      WHERE prior.quote_revision_id = NEW.supersedes_quote_revision_id
        AND prior.tenant_id = NEW.tenant_id
        AND prior.customer_quote_id = NEW.customer_quote_id
        AND prior.roof_job_id = NEW.roof_job_id
        AND prior.customer_id = NEW.customer_id
        AND prior.currency = NEW.currency
   );
END;

CREATE TRIGGER IF NOT EXISTS commercial_proposal_revision_sequence_guard
BEFORE INSERT ON commercial_proposal_revisions
BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_revision_sequence_conflict')
   WHERE NEW.revision_number != COALESCE((
     SELECT MAX(revision_number) + 1
       FROM commercial_proposal_revisions
      WHERE tenant_id = NEW.tenant_id AND proposal_pack_id = NEW.proposal_pack_id
   ), 1);
  SELECT RAISE(ABORT, 'commercial_proposal_revision_predecessor_conflict')
   WHERE NEW.supersedes_proposal_revision_id IS NOT (
     SELECT proposal_revision_id
       FROM commercial_proposal_revisions
      WHERE tenant_id = NEW.tenant_id AND proposal_pack_id = NEW.proposal_pack_id
      ORDER BY revision_number DESC LIMIT 1
   );
  SELECT RAISE(ABORT, 'commercial_proposal_identity_conflict')
   WHERE NEW.revision_number > 1 AND NOT EXISTS (
     SELECT 1
       FROM commercial_proposal_revisions prior
      WHERE prior.proposal_revision_id = NEW.supersedes_proposal_revision_id
        AND prior.tenant_id = NEW.tenant_id
        AND prior.proposal_pack_id = NEW.proposal_pack_id
        AND prior.roof_job_id = NEW.roof_job_id
        AND prior.customer_id = NEW.customer_id
   );
END;

CREATE TRIGGER IF NOT EXISTS commercial_publication_sequence_guard
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
       AND proposal.revision_number = (
         SELECT MAX(current.revision_number)
           FROM commercial_proposal_revisions current
          WHERE current.tenant_id = NEW.tenant_id
            AND current.proposal_pack_id = NEW.proposal_pack_id
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

CREATE TRIGGER IF NOT EXISTS commercial_acceptance_binding_guard
BEFORE INSERT ON commercial_acceptance_bindings
BEGIN
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
        AND quote.terms_hash = NEW.terms_hash
        AND proposal.roof_job_id = NEW.roof_job_id
        AND proposal.customer_id = NEW.customer_id
        AND proposal.quote_revision_id = quote.quote_revision_id
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

CREATE TRIGGER IF NOT EXISTS commercial_authority_permits_append_only_update
BEFORE UPDATE ON commercial_authority_permits BEGIN
  SELECT RAISE(ABORT, 'commercial_authority_permits_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_authority_permits_append_only_delete
BEFORE DELETE ON commercial_authority_permits BEGIN
  SELECT RAISE(ABORT, 'commercial_authority_permits_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_triage_decisions_append_only_update
BEFORE UPDATE ON commercial_lead_triage_decisions BEGIN
  SELECT RAISE(ABORT, 'commercial_triage_decisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_triage_decisions_append_only_delete
BEFORE DELETE ON commercial_lead_triage_decisions BEGIN
  SELECT RAISE(ABORT, 'commercial_triage_decisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_quote_revisions_append_only_update
BEFORE UPDATE ON commercial_quote_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_revisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_quote_revisions_append_only_delete
BEFORE DELETE ON commercial_quote_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_revisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_quote_lines_append_only_update
BEFORE UPDATE ON commercial_quote_lines BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_lines_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_quote_lines_append_only_delete
BEFORE DELETE ON commercial_quote_lines BEGIN
  SELECT RAISE(ABORT, 'commercial_quote_lines_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_proposal_revisions_append_only_update
BEFORE UPDATE ON commercial_proposal_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_revisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_proposal_revisions_append_only_delete
BEFORE DELETE ON commercial_proposal_revisions BEGIN
  SELECT RAISE(ABORT, 'commercial_proposal_revisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_publication_events_append_only_update
BEFORE UPDATE ON commercial_proposal_publication_events BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_publication_events_append_only_delete
BEFORE DELETE ON commercial_proposal_publication_events BEGIN
  SELECT RAISE(ABORT, 'commercial_publication_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_acceptance_bindings_append_only_update
BEFORE UPDATE ON commercial_acceptance_bindings BEGIN
  SELECT RAISE(ABORT, 'commercial_acceptance_bindings_append_only');
END;
CREATE TRIGGER IF NOT EXISTS commercial_acceptance_bindings_append_only_delete
BEFORE DELETE ON commercial_acceptance_bindings BEGIN
  SELECT RAISE(ABORT, 'commercial_acceptance_bindings_append_only');
END;
