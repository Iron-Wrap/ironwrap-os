-- 0061_accounting_exceptions.sql - the accountant queue.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S3, section 4.2. Every difference between local
-- truth and posted truth lands here rather than being corrected: "never adjust local truth to match
-- the provider. A difference is an exception, not a correction" (section 5.1).
--
-- Deviation from the contract's literal key, flagged rather than smuggled. Section 7.1 specifies
-- `UNIQUE (tenant_id, subject_ref, reason_code, status)`, mirroring `external_effect_exceptions`
-- in 0042. Taken literally with three statuses that key makes the *second* occurrence of a
-- recurring exception impossible to resolve: resolving it would collide with the already-resolved
-- row from the first occurrence, and a provider that drifts twice is not a rare case. The
-- dedupe the contract actually wants is "one live exception per subject and reason", so that is
-- what the partial unique index below enforces - the same expression, scoped to the statuses where
-- it does work. Resolved rows accumulate as history, which is what an audit trail is for.
--
-- Cross-plane discipline (contract section 3.1): `compensating_effect_id` is TEXT with no foreign
-- key into 0042.

CREATE TABLE accounting_exceptions (
  exception_id TEXT PRIMARY KEY CHECK (length(exception_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  -- What the exception is about, as `<aggregate>:<id>`, e.g. `accounting_intent:acct-intent:...`.
  -- TEXT rather than a column per aggregate so slices S6 and S7 can raise against a holdback
  -- ledger and a payroll posting without editing a shipped migration.
  subject_ref TEXT NOT NULL CHECK (length(subject_ref) BETWEEN 3 AND 220),
  intent_id TEXT,

  -- The bounded vocabulary. Codes for slices that have not shipped yet are declared here for the
  -- same reason: a migration is never edited after it ships, so the list has to be complete before
  -- S6 and S7 need it.
  reason_code TEXT NOT NULL CHECK (reason_code IN (
    -- Section 5.4, reconciliation (slice S3).
    'duplicate_provider_entity',
    'duplicate_provider_payment',
    'provider_overpayment',
    'provider_identity_conflict',
    'provider_entity_not_found',
    'provider_readback_drift',
    'expected_observed_mismatch',
    'settlement_invariant_violated',
    'unknown_effect_deadline_expired',
    -- Section 5.4, tax (slice S2).
    'tax_rate_drift',
    -- Reserved: section 5.4 holdback (S6) and payroll (S7).
    'holdback_over_released',
    'payroll_posting_mismatch'
  )),

  expected_sha256 TEXT CHECK (
    expected_sha256 IS NULL OR (
      length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  observed_sha256 TEXT CHECK (
    observed_sha256 IS NULL OR (
      length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  -- Identifiers, amounts and the provider-supported remedies on offer. Never a provider payload
  -- body and never a credential: section 6 admits hashes and identifiers into evidence.
  detail_json TEXT NOT NULL CHECK (length(detail_json) BETWEEN 2 AND 8192),

  status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
  -- Provider-supported only (section 6): void, credit memo, refund receipt, adjusting entry, or an
  -- explicit accept-as-posted decision. Never a local delete.
  resolution_action TEXT CHECK (resolution_action IS NULL OR resolution_action IN (
    'void_provider_entity', 'credit_memo_issued', 'refund_issued', 'adjusting_entry_posted',
    'accepted_as_posted', 'superseded_by_new_intent'
  )),
  compensating_effect_id TEXT CHECK (
    compensating_effect_id IS NULL OR length(compensating_effect_id) BETWEEN 8 AND 200
  ),
  acknowledged_by_user_id TEXT,
  acknowledged_at TEXT CHECK (acknowledged_at IS NULL OR length(acknowledged_at) BETWEEN 24 AND 40),
  resolved_by_user_id TEXT,
  resolved_at TEXT CHECK (resolved_at IS NULL OR length(resolved_at) BETWEEN 24 AND 40),
  opened_at TEXT NOT NULL CHECK (length(opened_at) BETWEEN 24 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 24 AND 40),

  CHECK ((status = 'resolved') = (resolved_by_user_id IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolution_action IS NOT NULL)),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK ((acknowledged_by_user_id IS NULL) = (acknowledged_at IS NULL)),
  CHECK (status != 'acknowledged' OR acknowledged_by_user_id IS NOT NULL),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (acknowledged_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

-- One live exception per subject and reason: re-raising the same finding on a later sweep updates
-- nothing and creates nothing, which is what keeps a scheduled sweep from flooding the queue.
CREATE UNIQUE INDEX idx_accounting_exceptions_live
  ON accounting_exceptions (tenant_id, subject_ref, reason_code)
  WHERE status != 'resolved';

CREATE INDEX idx_accounting_exceptions_queue
  ON accounting_exceptions (tenant_id, status, opened_at);
CREATE INDEX idx_accounting_exceptions_intent
  ON accounting_exceptions (tenant_id, intent_id, status);

CREATE TRIGGER accounting_exceptions_no_delete
BEFORE DELETE ON accounting_exceptions BEGIN
  SELECT RAISE(ABORT, 'accounting_exception_retained');
END;

-- An exception moves open -> acknowledged -> resolved, and resolved is terminal. Everything that
-- identifies the finding is written once: a queue whose subject or hashes could be edited after
-- the fact would be a record of what somebody decided to say, not of what happened.
CREATE TRIGGER accounting_exceptions_transition_guard
BEFORE UPDATE ON accounting_exceptions BEGIN
  SELECT RAISE(ABORT, 'accounting_exception_binding_immutable')
  WHERE NEW.exception_id != OLD.exception_id
     OR NEW.tenant_id != OLD.tenant_id
     OR NEW.subject_ref != OLD.subject_ref
     OR NEW.intent_id IS NOT OLD.intent_id
     OR NEW.reason_code != OLD.reason_code
     OR NEW.expected_sha256 IS NOT OLD.expected_sha256
     OR NEW.observed_sha256 IS NOT OLD.observed_sha256
     OR NEW.opened_at != OLD.opened_at;

  SELECT RAISE(ABORT, 'accounting_exception_transition_invalid')
  WHERE NOT (
    (OLD.status = 'open' AND NEW.status IN ('open', 'acknowledged', 'resolved'))
    OR (OLD.status = 'acknowledged' AND NEW.status IN ('acknowledged', 'resolved'))
  );

  SELECT RAISE(ABORT, 'accounting_exception_decision_immutable')
  WHERE (OLD.acknowledged_by_user_id IS NOT NULL
      AND NEW.acknowledged_by_user_id IS NOT OLD.acknowledged_by_user_id)
     OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS NOT OLD.acknowledged_at);
END;

-- Section 5.3: an `identity_conflict` "opens an exception, blocks compensation". Reversing an
-- entity we cannot prove is ours is worse than the conflict itself, so the refusal lives in the
-- storage layer rather than in whichever handler happens to remember it. Additive: this trigger is
-- declared here, on a table this migration owns, and 0058 is not touched.
CREATE TRIGGER accounting_exceptions_block_compensation
BEFORE INSERT ON accounting_intent_command_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_compensation_blocked')
  WHERE NEW.operation = 'compensate'
    AND EXISTS (
      SELECT 1 FROM accounting_exceptions e
       WHERE e.tenant_id = NEW.tenant_id
         AND e.subject_ref = 'accounting_intent:' || NEW.intent_id
         AND e.reason_code = 'provider_identity_conflict'
         AND e.status != 'resolved'
    );
END;

-- INSERT-time half of "a difference is an exception, not a correction", added after review of
-- PR #73. The reasoning and the real-D1 evidence are at the foot of `0059_tax_policy_snapshots.sql`:
-- `INSERT OR REPLACE` resolves a UNIQUE conflict with an internal delete that does not fire
-- `accounting_exceptions_no_delete`, so without this an exception could be made to disappear -
-- including a resolved one, which is the audit trail - by re-inserting over it.
--
-- Unlike the append-only fact tables in 0059/0060 this guard has no "same fact, carry on" branch,
-- and does not need one: `raiseAccountingException` reads the live exception first and returns it
-- rather than inserting, so a colliding insert already fails today on
-- `idx_accounting_exceptions_live`. The guard changes which error is raised, not whether one is.
-- The conflict predicate reproduces the partial index exactly - a resolved row on either side is
-- outside the index and does not collide, which is what lets a recurring finding be raised again.
CREATE TRIGGER accounting_exceptions_no_insert_replace
BEFORE INSERT ON accounting_exceptions BEGIN
  SELECT RAISE(ABORT, 'accounting_exception_retained')
  WHERE EXISTS (
    SELECT 1 FROM accounting_exceptions e
     WHERE e.exception_id = NEW.exception_id
        OR (e.tenant_id = NEW.tenant_id AND e.subject_ref = NEW.subject_ref
            AND e.reason_code = NEW.reason_code
            AND e.status != 'resolved' AND NEW.status != 'resolved')
  );
END;
