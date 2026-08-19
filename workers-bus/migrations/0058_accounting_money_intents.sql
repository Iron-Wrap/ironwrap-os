-- 0058_accounting_money_intents.sql - the IRO-52 money intent aggregate.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S1. One shared aggregate covers every money
-- intent kind rather than six near-identical per-kind tables (section 11, first rejected
-- alternative), and it mirrors `quickbooks_final_invoice_intents` rather than inventing a second
-- shape.
--
-- The contract reserved 0057 for this file; `main` had already shipped 0057, so it takes the next
-- free number above every migration on `main` and on every open PR head.
--
-- Cross-plane discipline (contract section 3.1):
--   * this migration declares no table owned by 0041 or 0042;
--   * `effect_id`, `effect_idempotency_key`, `compensates_effect_id` and `final_invoice_intent_id`
--     are TEXT with a documented invariant and no foreign key, so the money plane applies against
--     `main` unchanged and the reconciliation engine validates the references instead of D1.
--
-- Money is a TEXT decimal string, never a float (section 7.2). Ceiling comparisons cast to integer
-- cents with `replace(x, '.', '')`, which is exact because the column CHECK admits exactly two
-- decimal places.

CREATE TABLE accounting_intents (
  intent_id TEXT PRIMARY KEY CHECK (
    length(intent_id) BETWEEN 16 AND 160
    AND intent_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  -- Section 4.2. `payroll_journal` approval is the accountant's by section 6; open question 6
  -- (accountant identity) decides whether an owner may stand in, so the command guard below
  -- currently admits owner as the strictly higher authority.
  kind TEXT NOT NULL CHECK (kind IN (
    'deposit_invoice', 'progress_invoice', 'payment', 'credit_memo', 'refund',
    'holdback_release', 'tax_remittance_proposal', 'payroll_journal'
  )),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),

  -- The exact local commercial basis. Immutable after insert.
  basis_json TEXT NOT NULL CHECK (length(basis_json) BETWEEN 2 AND 32768),
  basis_sha256 TEXT NOT NULL CHECK (
    length(basis_sha256) = 64 AND basis_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_documents_json TEXT NOT NULL CHECK (length(source_documents_json) BETWEEN 2 AND 16384),
  -- The normalized fact set an authenticated readback must return for this intent to reconcile.
  expected_sha256 TEXT NOT NULL CHECK (
    length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- Section 5.4: bound at derivation and immutable. A rate change creates a new snapshot; an
  -- already-submitted intent keeps the one that was posted.
  tax_policy_snapshot_sha256 TEXT CHECK (
    tax_policy_snapshot_sha256 IS NULL OR (
      length(tax_policy_snapshot_sha256) = 64
      AND tax_policy_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),

  -- Provider identity plane.
  provider TEXT NOT NULL CHECK (provider = 'quickbooks'),
  realm_id TEXT NOT NULL CHECK (
    length(realm_id) BETWEEN 1 AND 32 AND realm_id NOT GLOB '*[^0-9]*'
  ),
  provider_entity_type TEXT CHECK (provider_entity_type IS NULL OR provider_entity_type IN (
    'Invoice', 'Payment', 'CreditMemo', 'RefundReceipt', 'JournalEntry', 'TimeActivity'
  )),
  provider_payload_json TEXT NOT NULL CHECK (length(provider_payload_json) BETWEEN 2 AND 32768),
  provider_payload_sha256 TEXT NOT NULL CHECK (
    length(provider_payload_sha256) = 64 AND provider_payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- Intuit's `requestid` de-duplication key, unique per realm.
  provider_request_id TEXT NOT NULL CHECK (length(provider_request_id) BETWEEN 8 AND 50),

  -- Money. TEXT decimal, exactly two places, single dot, optional leading minus.
  currency TEXT NOT NULL CHECK (currency = 'CAD'),
  subtotal TEXT NOT NULL CHECK (
    length(subtotal) BETWEEN 4 AND 14
    AND subtotal NOT GLOB '*[^0-9.-]*'
    AND substr(subtotal, -3, 1) = '.'
    AND length(subtotal) - length(replace(subtotal, '.', '')) = 1
    AND instr(substr(subtotal, 2), '-') = 0
  ),
  tax_amount TEXT NOT NULL CHECK (
    length(tax_amount) BETWEEN 4 AND 14
    AND tax_amount NOT GLOB '*[^0-9.-]*'
    AND substr(tax_amount, -3, 1) = '.'
    AND length(tax_amount) - length(replace(tax_amount, '.', '')) = 1
    AND instr(substr(tax_amount, 2), '-') = 0
  ),
  total_amount TEXT NOT NULL CHECK (
    length(total_amount) BETWEEN 4 AND 14
    AND total_amount NOT GLOB '*[^0-9.-]*'
    AND substr(total_amount, -3, 1) = '.'
    AND length(total_amount) - length(replace(total_amount, '.', '')) = 1
    AND instr(substr(total_amount, 2), '-') = 0
  ),
  -- Cumulative settled amount observed so far. Section 5.4 partial payment.
  settled_amount TEXT CHECK (
    settled_amount IS NULL OR (
      length(settled_amount) BETWEEN 4 AND 14
      AND settled_amount NOT GLOB '*[^0-9.-]*'
      AND substr(settled_amount, -3, 1) = '.'
      AND length(settled_amount) - length(replace(settled_amount, '.', '')) = 1
      AND instr(substr(settled_amount, 2), '-') = 0
    )
  ),

  -- Authority bound at derivation. `authority_max_amount` is the per-intent ceiling section 6
  -- requires; the runtime enforces the same ceiling on the effect with
  -- `effect_policy_amount_ceiling_exceeded`, and this column is what the command guard reads.
  authority_permit_ref TEXT NOT NULL CHECK (length(authority_permit_ref) BETWEEN 1 AND 160),
  authority_policy_ref TEXT NOT NULL CHECK (length(authority_policy_ref) BETWEEN 1 AND 160),
  authority_policy_version TEXT NOT NULL CHECK (length(authority_policy_version) BETWEEN 1 AND 32),
  authority_max_amount TEXT NOT NULL CHECK (
    length(authority_max_amount) BETWEEN 4 AND 14
    AND authority_max_amount NOT GLOB '*[^0-9.]*'
    AND substr(authority_max_amount, -3, 1) = '.'
    AND length(authority_max_amount) - length(replace(authority_max_amount, '.', '')) = 1
  ),

  -- Cross-plane references. TEXT by design: no foreign key into a 0041 or 0042 table.
  effect_id TEXT CHECK (effect_id IS NULL OR length(effect_id) BETWEEN 8 AND 160),
  effect_idempotency_key TEXT NOT NULL CHECK (length(effect_idempotency_key) BETWEEN 8 AND 160),
  compensates_effect_id TEXT CHECK (
    compensates_effect_id IS NULL OR length(compensates_effect_id) BETWEEN 8 AND 160
  ),
  final_invoice_intent_id TEXT CHECK (
    final_invoice_intent_id IS NULL OR length(final_invoice_intent_id) BETWEEN 16 AND 160
  ),
  -- Same-plane, so a real foreign key. A remedy intent points at the intent it reverses; the
  -- reversed intent is the one that reaches `compensating` / `compensated`.
  compensates_intent_id TEXT,

  state TEXT NOT NULL CHECK (state IN (
    'draft', 'blocked', 'pending_review', 'rejected', 'submission_pending', 'submitted',
    'uncertain', 'partially_settled', 'reconciled', 'mismatch', 'reconciliation_required',
    'compensating', 'compensated', 'failed'
  )),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  blocker_code TEXT CHECK (blocker_code IS NULL OR length(blocker_code) BETWEEN 1 AND 80),
  blocker_next_step TEXT CHECK (
    blocker_next_step IS NULL OR length(blocker_next_step) BETWEEN 1 AND 120
  ),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  error_code TEXT CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 80),

  -- Derivation and decision actors. Section 6 separation of duty.
  derived_by_actor_kind TEXT NOT NULL CHECK (derived_by_actor_kind IN ('agent', 'owner', 'accounting')),
  derived_by_user_id TEXT,
  derived_at TEXT NOT NULL CHECK (length(derived_at) BETWEEN 24 AND 40),
  approved_by_user_id TEXT,
  approved_at TEXT CHECK (approved_at IS NULL OR length(approved_at) BETWEEN 24 AND 40),
  approval_idempotency_sha256 TEXT CHECK (
    approval_idempotency_sha256 IS NULL OR (
      length(approval_idempotency_sha256) = 64
      AND approval_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  approval_fingerprint_sha256 TEXT CHECK (
    approval_fingerprint_sha256 IS NULL OR (
      length(approval_fingerprint_sha256) = 64
      AND approval_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rejected_by_user_id TEXT,
  rejected_at TEXT CHECK (rejected_at IS NULL OR length(rejected_at) BETWEEN 24 AND 40),
  rejection_idempotency_sha256 TEXT CHECK (
    rejection_idempotency_sha256 IS NULL OR (
      length(rejection_idempotency_sha256) = 64
      AND rejection_idempotency_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  rejection_fingerprint_sha256 TEXT CHECK (
    rejection_fingerprint_sha256 IS NULL OR (
      length(rejection_fingerprint_sha256) = 64
      AND rejection_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),

  -- Provider outcome. Only a readback writes `observed_sha256`.
  provider_entity_id TEXT CHECK (
    provider_entity_id IS NULL OR (
      length(provider_entity_id) BETWEEN 1 AND 32
      AND provider_entity_id NOT GLOB '*[^0-9]*'
    )
  ),
  observed_sha256 TEXT CHECK (
    observed_sha256 IS NULL OR (
      length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  provider_submitted_at TEXT CHECK (
    provider_submitted_at IS NULL OR length(provider_submitted_at) BETWEEN 24 AND 40
  ),
  provider_reconciled_at TEXT CHECK (
    provider_reconciled_at IS NULL OR length(provider_reconciled_at) BETWEEN 24 AND 40
  ),

  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),

  UNIQUE (tenant_id, basis_sha256),
  UNIQUE (tenant_id, effect_idempotency_key),
  UNIQUE (realm_id, provider_request_id),
  UNIQUE (tenant_id, approval_idempotency_sha256),
  UNIQUE (tenant_id, rejection_idempotency_sha256),
  FOREIGN KEY (derived_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (approved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (rejected_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (compensates_intent_id)
    REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,

  CHECK ((blocker_code IS NULL) = (blocker_next_step IS NULL)),
  CHECK (state != 'blocked' OR blocker_code IS NOT NULL),
  CHECK (state != 'rejected' OR rejected_by_user_id IS NOT NULL),
  CHECK (state != 'partially_settled' OR settled_amount IS NOT NULL),
  -- A human decision precedes every state that can reach the provider.
  CHECK (state IN ('draft', 'blocked', 'pending_review', 'rejected') OR approved_by_user_id IS NOT NULL),
  -- Section 6 separation of duty, backstopping the command-receipt guard.
  CHECK (
    approved_by_user_id IS NULL OR derived_by_user_id IS NULL
    OR approved_by_user_id != derived_by_user_id
  ),
  CHECK (derived_by_actor_kind != 'agent' OR derived_by_user_id IS NULL),
  CHECK (derived_by_actor_kind = 'agent' OR derived_by_user_id IS NOT NULL),
  -- Section 5.1: reconciled means an authenticated readback returned a fact set whose hash equals
  -- the expected hash. This is the money invariant, and D1 refuses any other route to the state.
  CHECK (
    state != 'reconciled'
    OR (observed_sha256 IS NOT NULL AND observed_sha256 = expected_sha256
      AND provider_reconciled_at IS NOT NULL)
  ),
  -- A tax remittance proposal creates nothing at the provider (section 4.1: propose and reconcile
  -- only, never file), so it is the one kind that carries no provider entity and no effect.
  CHECK ((kind = 'tax_remittance_proposal') = (provider_entity_type IS NULL)),
  CHECK (
    kind = 'tax_remittance_proposal'
    OR state NOT IN ('submitted', 'partially_settled', 'reconciled', 'mismatch',
      'compensating', 'compensated')
    OR (provider_entity_id IS NOT NULL AND effect_id IS NOT NULL)
  ),
  -- Section 5.4: the kinds whose comparison fact set carries tax must bind a snapshot.
  CHECK (
    kind NOT IN ('deposit_invoice', 'progress_invoice', 'credit_memo', 'holdback_release',
      'tax_remittance_proposal')
    OR tax_policy_snapshot_sha256 IS NOT NULL
  ),
  -- The ceiling is a bound fact, so an intent may never be derived already above it. The
  -- comparison is on magnitude: a credit memo and a refund carry a negative total (section 4.1),
  -- and a signed comparison would exempt exactly the reversing kinds section 6 gates hardest.
  CHECK (
    abs(CAST(replace(total_amount, '.', '') AS INTEGER))
    <= abs(CAST(replace(authority_max_amount, '.', '') AS INTEGER))
  )
);

CREATE INDEX idx_accounting_intents_actionable
  ON accounting_intents (tenant_id, state, updated_at);
CREATE INDEX idx_accounting_intents_provider
  ON accounting_intents (tenant_id, realm_id, provider_entity_id);
CREATE INDEX idx_accounting_intents_job
  ON accounting_intents (tenant_id, roof_job_id, kind);

CREATE TABLE accounting_intent_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'derived', 'blocked', 'pending_review', 'approved', 'rejected', 'submission_pending',
    'submitted', 'uncertain', 'partially_settled', 'reconciled', 'mismatch',
    'reconciliation_required', 'compensating', 'compensated', 'failed', 'draft'
  )),
  state_from TEXT,
  state_to TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'accounting', 'agent', 'system')),
  actor_user_id TEXT,
  basis_sha256 TEXT NOT NULL CHECK (
    length(basis_sha256) = 64 AND basis_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  detail_code TEXT CHECK (detail_code IS NULL OR length(detail_code) BETWEEN 1 AND 80),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 24 AND 40),
  UNIQUE (intent_id, intent_version),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_intent_events_intent
  ON accounting_intent_events (intent_id, event_seq);

CREATE TRIGGER accounting_intent_events_append_only_update
BEFORE UPDATE ON accounting_intent_events BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_events_append_only');
END;
CREATE TRIGGER accounting_intent_events_append_only_delete
BEFORE DELETE ON accounting_intent_events BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_events_append_only');
END;

-- Section 7.2: a retried PWA command is idempotent at the storage layer, not just in the handler.
CREATE TABLE accounting_intent_command_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('approve', 'reject', 'reconcile', 'compensate')),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  requested_version INTEGER NOT NULL CHECK (requested_version > 0),
  actor_user_id TEXT NOT NULL,
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_intent_command_receipts_intent
  ON accounting_intent_command_receipts (intent_id, created_at);

CREATE TRIGGER accounting_intent_command_receipts_append_only_update
BEFORE UPDATE ON accounting_intent_command_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_command_receipts_append_only');
END;
CREATE TRIGGER accounting_intent_command_receipts_append_only_delete
BEFORE DELETE ON accounting_intent_command_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_command_receipts_append_only');
END;

-- The receipt is the command. Inserting it validates the actor, the version, the source state and
-- the authority, then applies the transition, so a handler cannot approve by writing the intent
-- row directly and a replayed command cannot apply twice.
CREATE TRIGGER accounting_intent_command_receipts_apply
AFTER INSERT ON accounting_intent_command_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_command_actor_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM app_users u
     WHERE u.user_id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id
       AND u.active = 1 AND COALESCE(u.access_role, u.role) IN ('owner', 'accounting')
  );

  SELECT RAISE(ABORT, 'accounting_intent_command_version_invalid')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_intents i
     WHERE i.intent_id = NEW.intent_id AND i.tenant_id = NEW.tenant_id
       AND i.version = NEW.requested_version
       AND (
         (NEW.operation = 'approve' AND i.state = 'pending_review')
         OR (NEW.operation = 'reject' AND i.state IN ('pending_review', 'blocked'))
         OR (NEW.operation = 'reconcile' AND i.state IN (
           'submitted', 'uncertain', 'partially_settled', 'reconciled', 'mismatch',
           'reconciliation_required'))
         OR (NEW.operation = 'compensate' AND i.state IN ('mismatch', 'reconciliation_required'))
       )
  );

  SELECT RAISE(ABORT, 'accounting_intent_separation_of_duty')
  WHERE NEW.operation = 'approve'
    AND EXISTS (
      SELECT 1 FROM accounting_intents i
       WHERE i.intent_id = NEW.intent_id AND i.derived_by_user_id = NEW.actor_user_id
    );

  -- Section 6: a holdback release is the owner's, and so is any decision above the bound ceiling.
  -- Integer cents, because the money columns are TEXT decimals and never floats; magnitude,
  -- because a refund and a credit memo are negative and must not slip under a signed comparison.
  -- The table CHECK already refuses an over-ceiling row, so this is the backstop that still holds
  -- if that CHECK is ever relaxed — `accounting-intents.test.ts` exercises it with
  -- `PRAGMA ignore_check_constraints`.
  SELECT RAISE(ABORT, 'accounting_intent_owner_authority_required')
  WHERE NEW.operation IN ('approve', 'compensate')
    AND EXISTS (
      SELECT 1 FROM accounting_intents i
       WHERE i.intent_id = NEW.intent_id
         AND (
           i.kind = 'holdback_release'
           OR abs(CAST(replace(i.total_amount, '.', '') AS INTEGER))
              > abs(CAST(replace(i.authority_max_amount, '.', '') AS INTEGER))
         )
    )
    AND NOT EXISTS (
      SELECT 1 FROM app_users u
       WHERE u.user_id = NEW.actor_user_id AND u.tenant_id = NEW.tenant_id
         AND COALESCE(u.access_role, u.role) = 'owner'
    );

  UPDATE accounting_intents
     SET state = CASE NEW.operation
           WHEN 'approve' THEN 'submission_pending'
           WHEN 'reject' THEN 'rejected'
           WHEN 'reconcile' THEN 'reconciliation_required'
           ELSE 'compensating'
         END,
         version = version + 1,
         reason_code = COALESCE(NEW.reason_code, reason_code),
         approved_by_user_id = CASE WHEN NEW.operation = 'approve'
           THEN NEW.actor_user_id ELSE approved_by_user_id END,
         approved_at = CASE WHEN NEW.operation = 'approve'
           THEN NEW.created_at ELSE approved_at END,
         approval_idempotency_sha256 = CASE WHEN NEW.operation = 'approve'
           THEN NEW.idempotency_key_sha256 ELSE approval_idempotency_sha256 END,
         approval_fingerprint_sha256 = CASE WHEN NEW.operation = 'approve'
           THEN NEW.request_fingerprint_sha256 ELSE approval_fingerprint_sha256 END,
         rejected_by_user_id = CASE WHEN NEW.operation = 'reject'
           THEN NEW.actor_user_id ELSE rejected_by_user_id END,
         rejected_at = CASE WHEN NEW.operation = 'reject'
           THEN NEW.created_at ELSE rejected_at END,
         rejection_idempotency_sha256 = CASE WHEN NEW.operation = 'reject'
           THEN NEW.idempotency_key_sha256 ELSE rejection_idempotency_sha256 END,
         rejection_fingerprint_sha256 = CASE WHEN NEW.operation = 'reject'
           THEN NEW.request_fingerprint_sha256 ELSE rejection_fingerprint_sha256 END,
         updated_at = NEW.created_at
   WHERE intent_id = NEW.intent_id AND tenant_id = NEW.tenant_id
     AND version = NEW.requested_version;
END;

CREATE TRIGGER accounting_intents_insert_event
AFTER INSERT ON accounting_intents BEGIN
  INSERT INTO accounting_intent_events (
    tenant_id, intent_id, intent_version, event_type, state_from, state_to,
    actor_kind, actor_user_id, basis_sha256, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.intent_id, NEW.version, 'derived', NULL, NEW.state,
    NEW.derived_by_actor_kind, NEW.derived_by_user_id, NEW.basis_sha256,
    NEW.blocker_code, NEW.created_at
  );
END;

-- The legal state graph. `accounting-intents.ts` restates it as a map and a test asserts the two
-- agree, so the handler and the storage layer cannot drift apart.
CREATE TRIGGER accounting_intents_transition_guard
BEFORE UPDATE OF state ON accounting_intents BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_transition_invalid')
  WHERE NOT (
    (OLD.state = 'draft' AND NEW.state IN ('draft', 'blocked', 'pending_review'))
    OR (OLD.state = 'blocked' AND NEW.state IN ('blocked', 'draft', 'pending_review', 'rejected'))
    OR (OLD.state = 'pending_review'
      AND NEW.state IN ('pending_review', 'blocked', 'rejected', 'submission_pending'))
    OR (OLD.state = 'rejected' AND NEW.state = 'rejected')
    OR (OLD.state = 'submission_pending'
      AND NEW.state IN ('submission_pending', 'submitted', 'uncertain', 'failed', 'blocked'))
    OR (OLD.state = 'submitted' AND NEW.state IN (
      'submitted', 'reconciled', 'partially_settled', 'mismatch', 'reconciliation_required',
      'uncertain'))
    OR (OLD.state = 'uncertain' AND NEW.state IN (
      'uncertain', 'submitted', 'reconciled', 'mismatch', 'failed', 'reconciliation_required'))
    OR (OLD.state = 'partially_settled' AND NEW.state IN (
      'partially_settled', 'reconciled', 'mismatch', 'reconciliation_required'))
    OR (OLD.state = 'reconciled' AND NEW.state IN ('reconciled', 'reconciliation_required'))
    OR (OLD.state = 'mismatch' AND NEW.state IN (
      'mismatch', 'reconciled', 'reconciliation_required', 'compensating'))
    OR (OLD.state = 'reconciliation_required' AND NEW.state IN (
      'reconciliation_required', 'reconciled', 'partially_settled', 'mismatch', 'submitted',
      'compensating', 'failed'))
    OR (OLD.state = 'compensating'
      AND NEW.state IN ('compensating', 'compensated', 'mismatch', 'failed'))
    OR (OLD.state = 'compensated' AND NEW.state IN ('compensated', 'reconciliation_required'))
    OR (OLD.state = 'failed' AND NEW.state IN ('failed', 'pending_review', 'reconciliation_required'))
  );
END;

CREATE TRIGGER accounting_intents_version_guard
BEFORE UPDATE ON accounting_intents BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_version_invalid')
  WHERE NEW.version != OLD.version + 1;

  SELECT RAISE(ABORT, 'accounting_intent_basis_immutable')
  WHERE NEW.intent_id != OLD.intent_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.kind != OLD.kind
     OR NEW.roof_job_id != OLD.roof_job_id
     OR NEW.basis_json != OLD.basis_json
     OR NEW.basis_sha256 != OLD.basis_sha256
     OR NEW.source_documents_json != OLD.source_documents_json
     OR NEW.expected_sha256 != OLD.expected_sha256
     OR NEW.tax_policy_snapshot_sha256 IS NOT OLD.tax_policy_snapshot_sha256
     OR NEW.provider != OLD.provider
     OR NEW.realm_id != OLD.realm_id
     OR NEW.provider_entity_type IS NOT OLD.provider_entity_type
     OR NEW.provider_payload_json != OLD.provider_payload_json
     OR NEW.provider_payload_sha256 != OLD.provider_payload_sha256
     OR NEW.provider_request_id != OLD.provider_request_id
     OR NEW.currency != OLD.currency
     OR NEW.subtotal != OLD.subtotal
     OR NEW.tax_amount != OLD.tax_amount
     OR NEW.total_amount != OLD.total_amount
     OR NEW.authority_permit_ref != OLD.authority_permit_ref
     OR NEW.authority_policy_ref != OLD.authority_policy_ref
     OR NEW.authority_policy_version != OLD.authority_policy_version
     OR NEW.authority_max_amount != OLD.authority_max_amount
     OR NEW.effect_idempotency_key != OLD.effect_idempotency_key
     OR NEW.compensates_effect_id IS NOT OLD.compensates_effect_id
     OR NEW.compensates_intent_id IS NOT OLD.compensates_intent_id
     OR NEW.derived_by_actor_kind != OLD.derived_by_actor_kind
     OR NEW.derived_by_user_id IS NOT OLD.derived_by_user_id
     OR NEW.derived_at != OLD.derived_at
     OR NEW.created_at != OLD.created_at;

  -- Provider evidence is written once. A second readback creates a new observation (slice S3); it
  -- never overwrites the identity or the timestamps already recorded here.
  SELECT RAISE(ABORT, 'accounting_intent_provider_evidence_immutable')
  WHERE (OLD.effect_id IS NOT NULL AND NEW.effect_id IS NOT OLD.effect_id)
     OR (OLD.provider_entity_id IS NOT NULL
       AND NEW.provider_entity_id IS NOT OLD.provider_entity_id)
     OR (OLD.provider_submitted_at IS NOT NULL
       AND NEW.provider_submitted_at IS NOT OLD.provider_submitted_at);

  SELECT RAISE(ABORT, 'accounting_intent_decision_evidence_immutable')
  WHERE (OLD.approval_idempotency_sha256 IS NOT NULL AND (
          NEW.approval_idempotency_sha256 IS NOT OLD.approval_idempotency_sha256
          OR NEW.approval_fingerprint_sha256 IS NOT OLD.approval_fingerprint_sha256
          OR NEW.approved_by_user_id IS NOT OLD.approved_by_user_id
          OR NEW.approved_at IS NOT OLD.approved_at))
     OR (OLD.rejection_idempotency_sha256 IS NOT NULL AND (
          NEW.rejection_idempotency_sha256 IS NOT OLD.rejection_idempotency_sha256
          OR NEW.rejection_fingerprint_sha256 IS NOT OLD.rejection_fingerprint_sha256
          OR NEW.rejected_by_user_id IS NOT OLD.rejected_by_user_id
          OR NEW.rejected_at IS NOT OLD.rejected_at));
END;

CREATE TRIGGER accounting_intents_update_event
AFTER UPDATE ON accounting_intents BEGIN
  INSERT INTO accounting_intent_events (
    tenant_id, intent_id, intent_version, event_type, state_from, state_to,
    actor_kind, actor_user_id, basis_sha256, detail_code, occurred_at
  ) VALUES (
    NEW.tenant_id, NEW.intent_id, NEW.version,
    CASE
      WHEN NEW.state = 'submission_pending' AND OLD.state = 'pending_review' THEN 'approved'
      ELSE NEW.state
    END,
    OLD.state, NEW.state,
    CASE
      WHEN NEW.approved_by_user_id IS NOT OLD.approved_by_user_id
        OR NEW.rejected_by_user_id IS NOT OLD.rejected_by_user_id THEN 'accounting'
      ELSE 'system'
    END,
    CASE
      WHEN NEW.approved_by_user_id IS NOT OLD.approved_by_user_id THEN NEW.approved_by_user_id
      WHEN NEW.rejected_by_user_id IS NOT OLD.rejected_by_user_id THEN NEW.rejected_by_user_id
      ELSE NULL
    END,
    NEW.basis_sha256,
    COALESCE(NEW.error_code, NEW.blocker_code, NEW.reason_code),
    NEW.updated_at
  );
END;

-- Section 5.4: no money row is ever deleted. Reversal is a compensating effect, never a delete.
CREATE TRIGGER accounting_intents_no_delete
BEFORE DELETE ON accounting_intents BEGIN
  SELECT RAISE(ABORT, 'accounting_intents_retained');
END;
