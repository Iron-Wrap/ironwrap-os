-- 0056_service_case_lifecycle.sql - complaint, warranty, service, diagnosis, remedy, and cost recovery.
--
-- Numbers 0036-0049 are reserved by lanes that are still open against `main`; this migration takes
-- a deliberately distinct block so parallel lanes never collide on a filename.
--
-- A Warranty Packet proves closeout.  It cannot run a callback.  This migration adds the owned
-- service spine: one versioned complaint record bound to customer, property, job, asset, warranty
-- and consent; a triage decision that may carry a model advisory but never model final authority;
-- a diagnosis that issues a governed service Work Package; a remedy whose verification and customer
-- acceptance are separate, evidence-bound facts; and supplier/manufacturer/insurer cost recovery
-- carried by the same pending -> leased -> terminal -> reconciled effect shape the transition
-- kernel already uses.  Nothing here calls a provider.  Every correction reopens or supersedes;
-- no row is ever deleted and no history is rewritten.

CREATE TABLE IF NOT EXISTS service_cases (
  service_case_id TEXT PRIMARY KEY CHECK (
    length(service_case_id) BETWEEN 10 AND 100
    AND service_case_id GLOB 'svc_case_*'
    AND service_case_id NOT GLOB '*[^a-z0-9_]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 3 AND 140),
  property_key TEXT NOT NULL CHECK (length(property_key) BETWEEN 3 AND 140),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 3 AND 140),
  asset_ref TEXT CHECK (asset_ref IS NULL OR length(asset_ref) BETWEEN 3 AND 140),
  warranty_packet_id TEXT CHECK (
    warranty_packet_id IS NULL OR length(warranty_packet_id) BETWEEN 3 AND 140
  ),
  origin_work_package_ref TEXT CHECK (
    origin_work_package_ref IS NULL OR (
      length(origin_work_package_ref) BETWEEN 1 AND 140
      AND origin_work_package_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  severity TEXT NOT NULL CHECK (severity IN ('emergency', 'urgent', 'standard', 'monitor')),
  symptom_code TEXT NOT NULL CHECK (
    length(symptom_code) BETWEEN 3 AND 80
    AND symptom_code NOT GLOB '*[^a-z0-9_]*'
  ),
  reported_channel TEXT NOT NULL CHECK (
    reported_channel IN ('phone', 'portal', 'email', 'field', 'partner')
  ),
  -- A callback is customer contact.  The consent record that authorizes outbound contact is a
  -- required intake binding, not a later lookup.
  consent_ref TEXT NOT NULL CHECK (length(consent_ref) BETWEEN 3 AND 140),
  intake_evidence_digest TEXT NOT NULL CHECK (
    length(intake_evidence_digest) = 64 AND intake_evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  response_sla_minutes INTEGER NOT NULL CHECK (response_sla_minutes BETWEEN 15 AND 20160),
  response_due_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'intake', 'triaged', 'diagnosed', 'remedy_issued', 'remedy_verified',
      'customer_accepted', 'disputed', 'closed', 'reopened'
    )
  ),
  version INTEGER NOT NULL CHECK (version >= 1),
  last_event_type TEXT NOT NULL CHECK (
    last_event_type IN (
      'case_opened', 'duplicate_linked', 'triaged', 'diagnosed', 'remedy_issued',
      'remedy_verified', 'remedy_failed', 'customer_accepted', 'customer_disputed',
      'closed', 'reopened'
    )
  ),
  last_transition_code TEXT CHECK (
    last_transition_code IS NULL OR (
      length(last_transition_code) BETWEEN 3 AND 120
      AND last_transition_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  last_evidence_digest TEXT CHECK (
    last_evidence_digest IS NULL OR (
      length(last_evidence_digest) = 64 AND last_evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  duplicate_of_case_id TEXT,
  closure_reason TEXT CHECK (
    closure_reason IS NULL
    OR closure_reason IN ('remedied_accepted', 'no_fault_unknown', 'excluded', 'duplicate', 'withdrawn')
  ),
  closed_at TEXT,
  reopen_count INTEGER NOT NULL DEFAULT 0 CHECK (reopen_count BETWEEN 0 AND 50),
  opened_by_user_id TEXT NOT NULL,
  last_actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (response_due_at > created_at),
  -- An emergency callback cannot be parked behind a routine SLA.  Bounding the declared minutes
  -- alone is not enough: `response_due_at` is the column an SLA sweeper reads, so the ceiling is
  -- enforced against the actual due time too, whatever minutes the caller declared.
  CHECK (severity != 'emergency' OR response_sla_minutes <= 240),
  CHECK (
    severity != 'emergency'
    OR (
      datetime(response_due_at) IS NOT NULL
      AND datetime(response_due_at) <= datetime(created_at, '+240 minutes')
    )
  ),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL)),
  CHECK ((state = 'closed') = (closure_reason IS NOT NULL)),
  -- NULL-safe on purpose: `closure_reason = 'duplicate'` evaluates to NULL once a duplicate-linked
  -- case is reopened, and SQLite passes a CHECK that is not FALSE.  `IS` keeps the fence closed.
  CHECK (duplicate_of_case_id IS NULL OR closure_reason IS 'duplicate'),
  CHECK (closure_reason IS NOT 'duplicate' OR duplicate_of_case_id IS NOT NULL),
  CHECK (duplicate_of_case_id IS NULL OR duplicate_of_case_id != service_case_id),
  CHECK (state != 'reopened' OR reopen_count >= 1),
  FOREIGN KEY (opened_by_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT,
  FOREIGN KEY (last_actor_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT,
  FOREIGN KEY (duplicate_of_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT
);

-- One live callback per job and symptom.  A second report of the same symptom is recorded as a
-- linked duplicate, never as a second competing lifecycle.
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_cases_one_open_per_symptom
  ON service_cases (tenant_id, roof_job_id, symptom_code)
  WHERE state != 'closed';

CREATE INDEX IF NOT EXISTS idx_service_cases_response_due
  ON service_cases (tenant_id, state, response_due_at, service_case_id)
  WHERE state != 'closed';

CREATE INDEX IF NOT EXISTS idx_service_cases_job_created
  ON service_cases (tenant_id, roof_job_id, created_at DESC, service_case_id DESC);

CREATE TABLE IF NOT EXISTS service_case_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'case_opened', 'duplicate_linked', 'triaged', 'diagnosed', 'remedy_issued',
      'remedy_verified', 'remedy_failed', 'customer_accepted', 'customer_disputed',
      'closed', 'reopened'
    )
  ),
  case_state TEXT NOT NULL CHECK (
    case_state IN (
      'intake', 'triaged', 'diagnosed', 'remedy_issued', 'remedy_verified',
      'customer_accepted', 'disputed', 'closed', 'reopened'
    )
  ),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  actor_user_id TEXT NOT NULL,
  detail_code TEXT CHECK (
    detail_code IS NULL OR (
      length(detail_code) BETWEEN 3 AND 120
      AND detail_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  evidence_digest TEXT CHECK (
    evidence_digest IS NULL OR (
      length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at TEXT NOT NULL,
  UNIQUE (service_case_id, case_version, event_type),
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_case_events_case_created
  ON service_case_events (service_case_id, created_at DESC, event_id DESC);

-- Triage separates the callback classes.  A model or rule advisory may be recorded, but the final
-- category and responsibility always carry a named human authority: `authority_kind` admits one
-- value and the decision columns are mandatory.
CREATE TABLE IF NOT EXISTS service_case_triage (
  triage_id TEXT PRIMARY KEY CHECK (
    length(triage_id) BETWEEN 12 AND 100
    AND triage_id GLOB 'svc_triage_*'
    AND triage_id NOT GLOB '*[^a-z0-9_]*'
  ),
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  advisory_source TEXT NOT NULL CHECK (advisory_source IN ('model', 'rule', 'none')),
  advisory_category TEXT CHECK (
    advisory_category IS NULL
    OR advisory_category IN ('emergency', 'workmanship', 'material_manufacturer', 'weather', 'excluded', 'unknown')
  ),
  advisory_confidence_bps INTEGER CHECK (
    advisory_confidence_bps IS NULL OR advisory_confidence_bps BETWEEN 0 AND 10000
  ),
  final_category TEXT NOT NULL CHECK (
    final_category IN ('emergency', 'workmanship', 'material_manufacturer', 'weather', 'excluded', 'unknown')
  ),
  responsibility TEXT NOT NULL CHECK (
    responsibility IN (
      'ironwrap_workmanship', 'manufacturer', 'supplier', 'customer',
      'third_party', 'weather', 'undetermined'
    )
  ),
  authority_kind TEXT NOT NULL CHECK (authority_kind = 'human'),
  decided_by_user_id TEXT NOT NULL,
  decided_by_role TEXT NOT NULL CHECK (length(decided_by_role) BETWEEN 3 AND 140),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (service_case_id, case_version),
  CHECK (
    advisory_source = 'none'
    OR (advisory_category IS NOT NULL AND advisory_confidence_bps IS NOT NULL)
  ),
  CHECK (
    advisory_source != 'none'
    OR (advisory_category IS NULL AND advisory_confidence_bps IS NULL)
  ),
  -- Unknown is a real, reportable outcome: it may never silently assign blame.
  CHECK (final_category != 'unknown' OR responsibility = 'undetermined'),
  CHECK (final_category != 'excluded' OR responsibility IN ('customer', 'weather', 'third_party')),
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT,
  FOREIGN KEY (decided_by_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_case_triage_case
  ON service_case_triage (service_case_id, case_version DESC);

CREATE TABLE IF NOT EXISTS service_case_diagnoses (
  diagnosis_id TEXT PRIMARY KEY CHECK (
    length(diagnosis_id) BETWEEN 10 AND 100
    AND diagnosis_id GLOB 'svc_diag_*'
    AND diagnosis_id NOT GLOB '*[^a-z0-9_]*'
  ),
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  triage_id TEXT NOT NULL,
  root_cause_code TEXT NOT NULL CHECK (
    length(root_cause_code) BETWEEN 3 AND 120
    AND root_cause_code NOT GLOB '*[^a-z0-9_]*'
  ),
  corrective_action_code TEXT NOT NULL CHECK (
    length(corrective_action_code) BETWEEN 3 AND 120
    AND corrective_action_code NOT GLOB '*[^a-z0-9_]*'
  ),
  recurrence_of_case_id TEXT,
  -- Physical remedy work is issued only as a governed Work Package, never as free-form dispatch.
  work_package_ref TEXT NOT NULL CHECK (
    length(work_package_ref) BETWEEN 1 AND 140
    AND work_package_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  work_package_version INTEGER NOT NULL CHECK (work_package_version >= 1),
  warranty_reserve_cents INTEGER NOT NULL CHECK (warranty_reserve_cents BETWEEN 0 AND 100000000),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  diagnosed_by_user_id TEXT NOT NULL,
  diagnosed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (service_case_id, case_version),
  CHECK (recurrence_of_case_id IS NULL OR recurrence_of_case_id != service_case_id),
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT,
  FOREIGN KEY (triage_id) REFERENCES service_case_triage(triage_id) ON DELETE RESTRICT,
  FOREIGN KEY (recurrence_of_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT,
  FOREIGN KEY (diagnosed_by_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_case_diagnoses_recurrence
  ON service_case_diagnoses (tenant_id, root_cause_code, diagnosed_at DESC);

-- Remedy verification and customer acceptance are two separate facts.  A remedy that a supervisor
-- verified is still not accepted work, and a dispute never rewrites the verification evidence.
CREATE TABLE IF NOT EXISTS service_case_remedies (
  remedy_id TEXT PRIMARY KEY CHECK (
    length(remedy_id) BETWEEN 12 AND 100
    AND remedy_id GLOB 'svc_remedy_*'
    AND remedy_id NOT GLOB '*[^a-z0-9_]*'
  ),
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  diagnosis_id TEXT NOT NULL,
  scheduled_start_at TEXT NOT NULL,
  scheduled_end_at TEXT NOT NULL,
  parts_manifest_digest TEXT NOT NULL CHECK (
    length(parts_manifest_digest) = 64 AND parts_manifest_digest NOT GLOB '*[^0-9a-f]*'
  ),
  field_evidence_digest TEXT CHECK (
    field_evidence_digest IS NULL OR (
      length(field_evidence_digest) = 64 AND field_evidence_digest NOT GLOB '*[^0-9a-f]*'
    )
  ),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('pending', 'verified', 'failed')),
  verified_at TEXT,
  verified_by_user_id TEXT,
  failure_code TEXT CHECK (
    failure_code IS NULL OR (
      length(failure_code) BETWEEN 3 AND 120
      AND failure_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  customer_acceptance_state TEXT NOT NULL CHECK (
    customer_acceptance_state IN ('pending', 'accepted', 'disputed')
  ),
  customer_decision_at TEXT,
  customer_acceptance_ref TEXT CHECK (
    customer_acceptance_ref IS NULL OR length(customer_acceptance_ref) BETWEEN 3 AND 140
  ),
  dispute_code TEXT CHECK (
    dispute_code IS NULL OR (
      length(dispute_code) BETWEEN 3 AND 120
      AND dispute_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  cost_actual_cents INTEGER CHECK (
    cost_actual_cents IS NULL OR cost_actual_cents BETWEEN 0 AND 100000000
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (service_case_id, case_version),
  CHECK (scheduled_end_at > scheduled_start_at),
  CHECK (
    verification_state != 'pending'
    OR (
      field_evidence_digest IS NULL AND verified_at IS NULL AND verified_by_user_id IS NULL
      AND failure_code IS NULL AND cost_actual_cents IS NULL
      AND customer_acceptance_state = 'pending'
    )
  ),
  CHECK (
    verification_state != 'verified'
    OR (
      field_evidence_digest IS NOT NULL AND verified_at IS NOT NULL
      AND verified_by_user_id IS NOT NULL AND failure_code IS NULL
      AND cost_actual_cents IS NOT NULL
    )
  ),
  CHECK (
    verification_state != 'failed'
    OR (
      field_evidence_digest IS NOT NULL AND verified_at IS NOT NULL
      AND verified_by_user_id IS NOT NULL AND failure_code IS NOT NULL
      AND cost_actual_cents IS NOT NULL AND customer_acceptance_state = 'pending'
    )
  ),
  -- The customer is asked to accept verified work only.
  CHECK (customer_acceptance_state = 'pending' OR verification_state = 'verified'),
  CHECK (
    customer_acceptance_state != 'accepted'
    OR (
      customer_decision_at IS NOT NULL AND customer_acceptance_ref IS NOT NULL
      AND dispute_code IS NULL
    )
  ),
  CHECK (
    customer_acceptance_state != 'disputed'
    OR (
      customer_decision_at IS NOT NULL AND dispute_code IS NOT NULL
      AND customer_acceptance_ref IS NULL
    )
  ),
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT,
  FOREIGN KEY (diagnosis_id) REFERENCES service_case_diagnoses(diagnosis_id) ON DELETE RESTRICT,
  FOREIGN KEY (verified_by_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_case_remedies_schedule
  ON service_case_remedies (tenant_id, scheduled_start_at, remedy_id)
  WHERE verification_state = 'pending';

-- Supplier, manufacturer, and insurer recovery is one external side effect.  It carries the same
-- pending -> leased -> terminal -> reconciled shape as `governed_transition_outbox`: exactly one
-- attempt, no retry after a recorded attempt, and an uncertain attempt that can only leave that
-- state through reconciliation.
CREATE TABLE IF NOT EXISTS service_cost_recovery_claims (
  claim_id TEXT PRIMARY KEY CHECK (
    length(claim_id) BETWEEN 14 AND 100
    AND claim_id GLOB 'svc_recovery_*'
    AND claim_id NOT GLOB '*[^a-z0-9_]*'
  ),
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  case_version INTEGER NOT NULL CHECK (case_version >= 1),
  diagnosis_id TEXT NOT NULL,
  counterparty_kind TEXT NOT NULL CHECK (
    counterparty_kind IN ('supplier', 'manufacturer', 'insurer')
  ),
  counterparty_ref TEXT NOT NULL CHECK (length(counterparty_ref) BETWEEN 3 AND 140),
  claim_basis_code TEXT NOT NULL CHECK (
    length(claim_basis_code) BETWEEN 3 AND 120
    AND claim_basis_code NOT GLOB '*[^a-z0-9_]*'
  ),
  claimed_amount_cents INTEGER NOT NULL CHECK (claimed_amount_cents BETWEEN 1 AND 100000000),
  currency TEXT NOT NULL CHECK (currency = 'CAD'),
  evidence_digest TEXT NOT NULL CHECK (
    length(evidence_digest) = 64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'
  ),
  effect_kind TEXT NOT NULL CHECK (effect_kind = 'cost_recovery_claim_submission'),
  -- Governance facts the canonical effect runtime (IRO-38 `external_effects`) demands NOT NULL.
  -- They are only knowable while the claim is being created -- who authorized it, under which
  -- triage decision, against which correlated case, over which exact request -- so they are
  -- captured here rather than backfilled at re-seat time.  The remaining `external_effects`
  -- columns are either already present under another name (`idempotency_key`, `case_version` ->
  -- `aggregate_version`, `claim_id` -> `intent_id`, `effect_kind` -> `action`) or are lane
  -- constants fixed at re-seat (`aggregate_type`, `provider`, `retry_limit`, and the four
  -- `*_json` documents).
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'ops')),
  -- The triage decision that placed responsibility outside IronWrap's own crews.  Recovery has no
  -- other authority, so the authority reference is that decision and nothing else.
  authority_ref TEXT NOT NULL CHECK (
    length(authority_ref) BETWEEN 12 AND 100
    AND authority_ref GLOB 'svc_triage_*'
    AND authority_ref NOT GLOB '*[^a-z0-9_]*'
  ),
  correlation_id TEXT NOT NULL CHECK (
    length(correlation_id) BETWEEN 8 AND 160
    AND correlation_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  deadline_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 140
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'succeeded', 'failed', 'uncertain', 'reconciled')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  attempt_mode TEXT NOT NULL DEFAULT 'none' CHECK (
    attempt_mode IN ('none', 'leased', 'inferred_terminal')
  ),
  due_at TEXT NOT NULL,
  lease_ref TEXT,
  lease_expires_at TEXT,
  attempted_at TEXT,
  result_ref TEXT,
  result_code TEXT CHECK (
    result_code IS NULL OR (
      length(result_code) BETWEEN 3 AND 120
      AND result_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  recovered_amount_cents INTEGER CHECK (
    recovered_amount_cents IS NULL OR recovered_amount_cents BETWEEN 0 AND 100000000
  ),
  reconciled_at TEXT,
  reconciliation_outcome TEXT CHECK (
    reconciliation_outcome IS NULL
    OR reconciliation_outcome IN ('executed', 'not_executed', 'inconclusive')
  ),
  reconciliation_ref TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, service_case_id, counterparty_kind, idempotency_key),
  CHECK (
    state != 'pending'
    OR (
      attempt_count = 0 AND attempt_mode = 'none' AND attempted_at IS NULL AND lease_ref IS NULL
      AND lease_expires_at IS NULL AND result_ref IS NULL AND result_code IS NULL
      AND recovered_amount_cents IS NULL AND reconciled_at IS NULL
      AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (
    state != 'leased'
    OR (
      attempt_count = 1 AND attempt_mode = 'leased' AND attempted_at IS NOT NULL
      AND lease_ref = idempotency_key AND lease_expires_at IS NOT NULL
      AND lease_expires_at > attempted_at AND result_ref IS NULL AND result_code IS NULL
      AND recovered_amount_cents IS NULL AND reconciled_at IS NULL
      AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (
    state NOT IN ('succeeded', 'failed')
    OR (
      attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal')
      AND attempted_at IS NOT NULL AND lease_ref = idempotency_key
      AND lease_expires_at IS NULL AND result_ref IS NOT NULL
      AND reconciled_at IS NULL AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (state != 'succeeded' OR (result_code IS NULL AND recovered_amount_cents IS NOT NULL)),
  CHECK (state != 'failed' OR (result_code IS NOT NULL AND recovered_amount_cents IS NULL)),
  CHECK (
    state != 'uncertain'
    OR (
      attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal')
      AND attempted_at IS NOT NULL AND lease_ref = idempotency_key
      AND lease_expires_at IS NULL AND result_ref IS NOT NULL AND result_code IS NOT NULL
      AND recovered_amount_cents IS NULL AND reconciled_at IS NULL
      AND reconciliation_outcome IS NULL AND reconciliation_ref IS NULL
    )
  ),
  CHECK (
    state != 'reconciled'
    OR (
      attempt_count = 1 AND attempt_mode IN ('leased', 'inferred_terminal')
      AND attempted_at IS NOT NULL AND lease_ref = idempotency_key
      AND lease_expires_at IS NULL AND result_ref IS NOT NULL AND result_code IS NOT NULL
      AND reconciled_at IS NOT NULL AND reconciliation_outcome IS NOT NULL
      AND reconciliation_ref IS NOT NULL
    )
  ),
  CHECK (
    reconciliation_outcome IS NOT 'executed' OR recovered_amount_cents IS NOT NULL
  ),
  CHECK (deadline_at > created_at),
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT,
  FOREIGN KEY (diagnosis_id) REFERENCES service_case_diagnoses(diagnosis_id) ON DELETE RESTRICT,
  FOREIGN KEY (authority_ref) REFERENCES service_case_triage(triage_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES app_users(user_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_cost_recovery_claims_pending
  ON service_cost_recovery_claims (tenant_id, due_at, claim_id)
  WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS service_cost_recovery_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  service_case_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('intent_recorded', 'leased', 'succeeded', 'failed', 'uncertain', 'reconciled')
  ),
  claim_state TEXT NOT NULL CHECK (
    claim_state IN ('pending', 'leased', 'succeeded', 'failed', 'uncertain', 'reconciled')
  ),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 1),
  attempt_mode TEXT NOT NULL CHECK (attempt_mode IN ('none', 'leased', 'inferred_terminal')),
  lease_ref TEXT,
  result_ref TEXT,
  result_code TEXT CHECK (
    result_code IS NULL OR (
      length(result_code) BETWEEN 3 AND 120
      AND result_code NOT GLOB '*[^a-z0-9_:-]*'
    )
  ),
  reconciliation_ref TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (claim_id, event_type),
  FOREIGN KEY (claim_id) REFERENCES service_cost_recovery_claims(claim_id) ON DELETE RESTRICT,
  FOREIGN KEY (service_case_id) REFERENCES service_cases(service_case_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_service_cost_recovery_events_created
  ON service_cost_recovery_events (tenant_id, created_at DESC, event_id DESC);

-- A case is opened at intake, or born already closed as a linked duplicate.  Nothing else.
CREATE TRIGGER IF NOT EXISTS service_cases_valid_open
BEFORE INSERT ON service_cases
BEGIN
  SELECT RAISE(ABORT, 'service_case_invalid_initial_state')
    WHERE NOT (
      (
        NEW.state = 'intake' AND NEW.version = 1 AND NEW.reopen_count = 0
        AND NEW.last_event_type = 'case_opened' AND NEW.duplicate_of_case_id IS NULL
      )
      OR (
        NEW.state = 'closed' AND NEW.version = 1 AND NEW.reopen_count = 0
        AND NEW.last_event_type = 'duplicate_linked' AND NEW.duplicate_of_case_id IS NOT NULL
      )
    );
  SELECT RAISE(ABORT, 'service_case_duplicate_target_must_share_job')
    WHERE NEW.duplicate_of_case_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM service_cases original
        WHERE original.service_case_id = NEW.duplicate_of_case_id
          AND original.tenant_id = NEW.tenant_id
          AND original.roof_job_id = NEW.roof_job_id
          AND original.symptom_code = NEW.symptom_code
      );
END;

CREATE TRIGGER IF NOT EXISTS service_cases_append_open_event
AFTER INSERT ON service_cases
BEGIN
  INSERT INTO service_case_events (
    service_case_id, tenant_id, event_type, case_state, case_version, actor_user_id,
    detail_code, evidence_digest, created_at
  ) VALUES (
    NEW.service_case_id, NEW.tenant_id, NEW.last_event_type, NEW.state, NEW.version,
    NEW.opened_by_user_id, NEW.last_transition_code, NEW.intake_evidence_digest, NEW.created_at
  );
END;

-- Case identity, its customer/property/job/warranty binding, and the intake evidence are frozen.
-- Only the lifecycle columns may advance, and every advance is one version step by a named actor.
CREATE TRIGGER IF NOT EXISTS service_cases_immutable_binding
BEFORE UPDATE ON service_cases
BEGIN
  SELECT RAISE(ABORT, 'service_case_binding_immutable')
    WHERE NEW.service_case_id IS NOT OLD.service_case_id
      OR NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.customer_id IS NOT OLD.customer_id
      OR NEW.property_key IS NOT OLD.property_key
      OR NEW.roof_job_id IS NOT OLD.roof_job_id
      OR NEW.asset_ref IS NOT OLD.asset_ref
      OR NEW.warranty_packet_id IS NOT OLD.warranty_packet_id
      OR NEW.origin_work_package_ref IS NOT OLD.origin_work_package_ref
      OR NEW.severity IS NOT OLD.severity
      OR NEW.symptom_code IS NOT OLD.symptom_code
      OR NEW.reported_channel IS NOT OLD.reported_channel
      OR NEW.consent_ref IS NOT OLD.consent_ref
      OR NEW.intake_evidence_digest IS NOT OLD.intake_evidence_digest
      OR NEW.response_sla_minutes IS NOT OLD.response_sla_minutes
      OR NEW.response_due_at IS NOT OLD.response_due_at
      OR NEW.opened_by_user_id IS NOT OLD.opened_by_user_id
      OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'service_case_version_step_required')
    WHERE NEW.version IS NOT OLD.version + 1;
  SELECT RAISE(ABORT, 'service_case_duplicate_link_immutable')
    WHERE NEW.duplicate_of_case_id IS NOT OLD.duplicate_of_case_id;
END;

CREATE TRIGGER IF NOT EXISTS service_cases_valid_transition
BEFORE UPDATE OF state ON service_cases
BEGIN
  SELECT RAISE(ABORT, 'service_case_transition_not_allowed')
    WHERE NOT (
      (OLD.state = 'intake' AND NEW.state IN ('triaged', 'closed'))
      OR (OLD.state = 'triaged' AND NEW.state IN ('diagnosed', 'closed'))
      OR (OLD.state = 'diagnosed' AND NEW.state IN ('remedy_issued', 'closed', 'diagnosed'))
      OR (OLD.state = 'remedy_issued' AND NEW.state IN ('remedy_verified', 'diagnosed'))
      OR (OLD.state = 'remedy_verified' AND NEW.state IN ('customer_accepted', 'disputed'))
      OR (OLD.state = 'customer_accepted' AND NEW.state = 'closed')
      OR (OLD.state = 'disputed' AND NEW.state IN ('diagnosed', 'closed'))
      OR (OLD.state = 'closed' AND NEW.state = 'reopened')
      OR (OLD.state = 'reopened' AND NEW.state = 'triaged')
    );
  SELECT RAISE(ABORT, 'service_case_event_type_mismatch')
    WHERE NOT (
      (NEW.state = 'triaged' AND NEW.last_event_type = 'triaged')
      OR (NEW.state = 'diagnosed' AND OLD.state = 'triaged' AND NEW.last_event_type = 'diagnosed')
      OR (NEW.state = 'diagnosed' AND OLD.state = 'remedy_issued' AND NEW.last_event_type = 'remedy_failed')
      OR (NEW.state = 'diagnosed' AND OLD.state = 'disputed' AND NEW.last_event_type = 'diagnosed')
      OR (NEW.state = 'diagnosed' AND OLD.state = 'diagnosed' AND NEW.last_event_type = 'diagnosed')
      OR (NEW.state = 'remedy_issued' AND NEW.last_event_type = 'remedy_issued')
      OR (NEW.state = 'remedy_verified' AND NEW.last_event_type = 'remedy_verified')
      OR (NEW.state = 'customer_accepted' AND NEW.last_event_type = 'customer_accepted')
      OR (NEW.state = 'disputed' AND NEW.last_event_type = 'customer_disputed')
      OR (NEW.state = 'closed' AND NEW.last_event_type = 'closed')
      OR (NEW.state = 'reopened' AND NEW.last_event_type = 'reopened')
    );
  -- Accepted work closes as remedied; an unresolved case may only close as one of the honest
  -- non-remedied outcomes.
  SELECT RAISE(ABORT, 'service_case_closure_reason_not_allowed')
    WHERE NEW.state = 'closed'
      AND NOT (
        (OLD.state = 'customer_accepted' AND NEW.closure_reason = 'remedied_accepted')
        OR (OLD.state = 'intake' AND NEW.closure_reason IN ('excluded', 'withdrawn'))
        OR (OLD.state = 'triaged' AND NEW.closure_reason IN ('no_fault_unknown', 'excluded', 'withdrawn'))
        OR (OLD.state = 'diagnosed' AND NEW.closure_reason IN ('no_fault_unknown', 'withdrawn'))
        OR (OLD.state = 'disputed' AND NEW.closure_reason IN ('excluded', 'withdrawn'))
      );
  -- Reopening corrects a closed case forward; it never erases the closure that came before.
  SELECT RAISE(ABORT, 'service_case_reopen_must_preserve_history')
    WHERE NEW.state = 'reopened'
      AND NOT (
        NEW.reopen_count = OLD.reopen_count + 1
        AND NEW.closure_reason IS NULL
        AND NEW.closed_at IS NULL
        AND NEW.last_transition_code IS NOT NULL
      );
  SELECT RAISE(ABORT, 'service_case_reopen_count_frozen')
    WHERE NEW.state != 'reopened' AND NEW.reopen_count IS NOT OLD.reopen_count;
  -- A triage decision, diagnosis, remedy record, and closure each carry their own evidence.
  SELECT RAISE(ABORT, 'service_case_transition_evidence_required')
    WHERE NEW.state IN ('triaged', 'diagnosed', 'remedy_issued', 'remedy_verified', 'customer_accepted', 'disputed')
      AND NEW.last_evidence_digest IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS service_cases_append_transition_event
AFTER UPDATE OF state ON service_cases
BEGIN
  INSERT INTO service_case_events (
    service_case_id, tenant_id, event_type, case_state, case_version, actor_user_id,
    detail_code, evidence_digest, created_at
  ) VALUES (
    NEW.service_case_id, NEW.tenant_id, NEW.last_event_type, NEW.state, NEW.version,
    NEW.last_actor_user_id, NEW.last_transition_code, NEW.last_evidence_digest, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS service_cases_append_only_delete
BEFORE DELETE ON service_cases
BEGIN
  SELECT RAISE(ABORT, 'service_cases_append_only');
END;

CREATE TRIGGER IF NOT EXISTS service_case_events_immutable
BEFORE UPDATE ON service_case_events
BEGIN
  SELECT RAISE(ABORT, 'service_case_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS service_case_events_append_only_delete
BEFORE DELETE ON service_case_events
BEGIN
  SELECT RAISE(ABORT, 'service_case_events_append_only');
END;

-- A triage row is the authority record for one case version; it is written once and never edited.
CREATE TRIGGER IF NOT EXISTS service_case_triage_matches_case_version
BEFORE INSERT ON service_case_triage
BEGIN
  SELECT RAISE(ABORT, 'service_case_triage_case_version_mismatch')
    WHERE NOT EXISTS (
      SELECT 1 FROM service_cases owner
      WHERE owner.service_case_id = NEW.service_case_id
        AND owner.tenant_id = NEW.tenant_id
        AND owner.version = NEW.case_version
        AND owner.state IN ('intake', 'reopened')
    );
END;

CREATE TRIGGER IF NOT EXISTS service_case_triage_immutable
BEFORE UPDATE ON service_case_triage
BEGIN
  SELECT RAISE(ABORT, 'service_case_triage_immutable');
END;

CREATE TRIGGER IF NOT EXISTS service_case_triage_append_only_delete
BEFORE DELETE ON service_case_triage
BEGIN
  SELECT RAISE(ABORT, 'service_case_triage_append_only');
END;

-- Only a case whose triage found a real fault may be diagnosed into remedy work.
CREATE TRIGGER IF NOT EXISTS service_case_diagnoses_require_actionable_triage
BEFORE INSERT ON service_case_diagnoses
BEGIN
  SELECT RAISE(ABORT, 'service_case_diagnosis_requires_actionable_triage')
    WHERE NOT EXISTS (
      SELECT 1 FROM service_case_triage source
      WHERE source.triage_id = NEW.triage_id
        AND source.service_case_id = NEW.service_case_id
        AND source.tenant_id = NEW.tenant_id
        AND source.final_category NOT IN ('excluded', 'unknown')
        AND source.responsibility != 'undetermined'
    );
END;

CREATE TRIGGER IF NOT EXISTS service_case_diagnoses_immutable
BEFORE UPDATE ON service_case_diagnoses
BEGIN
  SELECT RAISE(ABORT, 'service_case_diagnoses_immutable');
END;

CREATE TRIGGER IF NOT EXISTS service_case_diagnoses_append_only_delete
BEFORE DELETE ON service_case_diagnoses
BEGIN
  SELECT RAISE(ABORT, 'service_case_diagnoses_append_only');
END;

CREATE TRIGGER IF NOT EXISTS service_case_remedies_immutable_binding
BEFORE UPDATE ON service_case_remedies
BEGIN
  SELECT RAISE(ABORT, 'service_case_remedy_binding_immutable')
    WHERE NEW.remedy_id IS NOT OLD.remedy_id
      OR NEW.service_case_id IS NOT OLD.service_case_id
      OR NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.case_version IS NOT OLD.case_version
      OR NEW.diagnosis_id IS NOT OLD.diagnosis_id
      OR NEW.scheduled_start_at IS NOT OLD.scheduled_start_at
      OR NEW.scheduled_end_at IS NOT OLD.scheduled_end_at
      OR NEW.parts_manifest_digest IS NOT OLD.parts_manifest_digest
      OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'service_case_remedy_verification_final')
    WHERE OLD.verification_state != 'pending' AND NEW.verification_state IS NOT OLD.verification_state;
  SELECT RAISE(ABORT, 'service_case_remedy_evidence_final')
    WHERE OLD.field_evidence_digest IS NOT NULL
      AND NEW.field_evidence_digest IS NOT OLD.field_evidence_digest;
  SELECT RAISE(ABORT, 'service_case_remedy_customer_decision_final')
    WHERE OLD.customer_acceptance_state != 'pending'
      AND NEW.customer_acceptance_state IS NOT OLD.customer_acceptance_state;
END;

CREATE TRIGGER IF NOT EXISTS service_case_remedies_append_only_delete
BEFORE DELETE ON service_case_remedies
BEGIN
  SELECT RAISE(ABORT, 'service_case_remedies_append_only');
END;

-- Recovery may only be claimed where triage placed responsibility outside IronWrap's own crews.
CREATE TRIGGER IF NOT EXISTS service_cost_recovery_requires_external_responsibility
BEFORE INSERT ON service_cost_recovery_claims
BEGIN
  SELECT RAISE(ABORT, 'service_cost_recovery_responsibility_required')
    WHERE NOT EXISTS (
      SELECT 1 FROM service_case_triage source
      INNER JOIN service_case_diagnoses diagnosis
        ON diagnosis.triage_id = source.triage_id
      WHERE diagnosis.diagnosis_id = NEW.diagnosis_id
        AND source.service_case_id = NEW.service_case_id
        AND source.tenant_id = NEW.tenant_id
        AND source.responsibility IN ('manufacturer', 'supplier', 'third_party')
    );
  -- The recorded authority is not free text: it must be the very triage decision the diagnosis was
  -- made under, so a claim can never cite some other case's decision as its authority.
  SELECT RAISE(ABORT, 'service_cost_recovery_authority_ref_mismatch')
    WHERE NEW.authority_ref IS NOT (
      SELECT diagnosis.triage_id
      FROM service_case_diagnoses diagnosis
      WHERE diagnosis.diagnosis_id = NEW.diagnosis_id
    );
  -- Every effect raised for one case correlates under one id, so a later runtime can gather them.
  SELECT RAISE(ABORT, 'service_cost_recovery_correlation_mismatch')
    WHERE NEW.correlation_id IS NOT 'svc-case:' || NEW.service_case_id;
  SELECT RAISE(ABORT, 'service_cost_recovery_intent_must_be_pending')
    WHERE NEW.state != 'pending';
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_claims_immutable_binding
BEFORE UPDATE ON service_cost_recovery_claims
BEGIN
  SELECT RAISE(ABORT, 'service_cost_recovery_binding_immutable')
    WHERE NEW.claim_id IS NOT OLD.claim_id
      OR NEW.service_case_id IS NOT OLD.service_case_id
      OR NEW.tenant_id IS NOT OLD.tenant_id
      OR NEW.case_version IS NOT OLD.case_version
      OR NEW.diagnosis_id IS NOT OLD.diagnosis_id
      OR NEW.counterparty_kind IS NOT OLD.counterparty_kind
      OR NEW.counterparty_ref IS NOT OLD.counterparty_ref
      OR NEW.claim_basis_code IS NOT OLD.claim_basis_code
      OR NEW.claimed_amount_cents IS NOT OLD.claimed_amount_cents
      OR NEW.currency IS NOT OLD.currency
      OR NEW.evidence_digest IS NOT OLD.evidence_digest
      OR NEW.effect_kind IS NOT OLD.effect_kind
      OR NEW.idempotency_key IS NOT OLD.idempotency_key
      OR NEW.actor_user_id IS NOT OLD.actor_user_id
      OR NEW.actor_role IS NOT OLD.actor_role
      OR NEW.authority_ref IS NOT OLD.authority_ref
      OR NEW.correlation_id IS NOT OLD.correlation_id
      OR NEW.request_hash IS NOT OLD.request_hash
      OR NEW.deadline_at IS NOT OLD.deadline_at
      OR NEW.due_at IS NOT OLD.due_at
      OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'service_cost_recovery_state_change_required')
    WHERE OLD.state IS NEW.state;
  SELECT RAISE(ABORT, 'service_cost_recovery_invalid_pending_transition')
    WHERE OLD.state = 'pending' AND NEW.state NOT IN ('leased', 'succeeded', 'failed', 'uncertain');
  SELECT RAISE(ABORT, 'service_cost_recovery_invalid_leased_transition')
    WHERE OLD.state = 'leased' AND NEW.state NOT IN ('succeeded', 'failed', 'uncertain');
  SELECT RAISE(ABORT, 'service_cost_recovery_invalid_uncertain_transition')
    WHERE OLD.state = 'uncertain' AND NEW.state != 'reconciled';
  SELECT RAISE(ABORT, 'service_cost_recovery_terminal')
    WHERE OLD.state IN ('succeeded', 'failed', 'reconciled');
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_claims_append_only_delete
BEFORE DELETE ON service_cost_recovery_claims
BEGIN
  SELECT RAISE(ABORT, 'service_cost_recovery_claims_append_only');
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_append_intent_event
AFTER INSERT ON service_cost_recovery_claims
BEGIN
  INSERT INTO service_cost_recovery_events (
    claim_id, service_case_id, tenant_id, event_type, claim_state, attempt_count, attempt_mode,
    lease_ref, result_ref, result_code, reconciliation_ref, created_at
  ) VALUES (
    NEW.claim_id, NEW.service_case_id, NEW.tenant_id, 'intent_recorded', NEW.state,
    NEW.attempt_count, NEW.attempt_mode, NULL, NULL, NULL, NULL, NEW.created_at
  );
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_append_state_event
AFTER UPDATE OF state ON service_cost_recovery_claims
BEGIN
  INSERT INTO service_cost_recovery_events (
    claim_id, service_case_id, tenant_id, event_type, claim_state, attempt_count, attempt_mode,
    lease_ref, result_ref, result_code, reconciliation_ref, created_at
  ) VALUES (
    NEW.claim_id, NEW.service_case_id, NEW.tenant_id, NEW.state, NEW.state,
    NEW.attempt_count, NEW.attempt_mode, NEW.lease_ref, NEW.result_ref, NEW.result_code,
    NEW.reconciliation_ref, NEW.updated_at
  );
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_events_immutable
BEFORE UPDATE ON service_cost_recovery_events
BEGIN
  SELECT RAISE(ABORT, 'service_cost_recovery_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS service_cost_recovery_events_append_only_delete
BEFORE DELETE ON service_cost_recovery_events
BEGIN
  SELECT RAISE(ABORT, 'service_cost_recovery_events_append_only');
END;
