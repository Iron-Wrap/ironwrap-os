-- 0060_accounting_provider_observations.sql - authenticated provider readbacks and their verdicts.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S3, section 4.2. An observation is what the
-- provider said existed at a moment, and it is immutable: "a later read creates a new observation
-- that supersedes; it never overwrites".
--
-- Supersession without mutation. The current observation for an entity is the one with the highest
-- `observation_seq`; nothing is ever flagged, closed, or rewritten. An `is_current` column would
-- have to be UPDATEd, which is precisely the write the append-only triggers below forbid, so the
-- ordering is the supersession and `readCurrentObservation` is the only reader of that rule.
--
-- Money appears twice on purpose: `facts_json` holds exact TEXT decimals for hashing, and the
-- `*_cents` columns hold integer cents because the cumulative settlement invariant of section 5.4
-- is a SUM, and section 7.2 admits integer cents exactly where a total is summed.
--
-- Cross-plane discipline (contract section 3.1): `effect_attempt_id` is TEXT with no foreign key
-- into 0042.

CREATE TABLE accounting_observations (
  observation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL UNIQUE CHECK (length(observation_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  realm_id TEXT NOT NULL CHECK (
    length(realm_id) BETWEEN 1 AND 32 AND realm_id NOT GLOB '*[^0-9]*'
  ),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'Invoice', 'Payment', 'CreditMemo', 'RefundReceipt', 'JournalEntry', 'TimeActivity'
  )),
  entity_id TEXT NOT NULL CHECK (
    length(entity_id) BETWEEN 1 AND 32 AND entity_id NOT GLOB '*[^0-9]*'
  ),
  -- The intent this read was made for, when there is one. A Payment observed while reconciling an
  -- Invoice is a fact about the invoice's settlement and belongs to no intent of its own, so this
  -- is nullable rather than forcing a synthetic intent into existence.
  intent_id TEXT,

  -- The normalized comparison fact set of section 5.2, exactly as hashed.
  facts_json TEXT NOT NULL CHECK (length(facts_json) BETWEEN 2 AND 32768),
  observed_sha256 TEXT NOT NULL CHECK (
    length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'
  ),

  -- Unhashed settlement inputs. NULL where the entity has no such fact.
  total_amount_cents INTEGER,
  balance_cents INTEGER,
  unapplied_amount_cents INTEGER,

  read_at TEXT NOT NULL CHECK (length(read_at) BETWEEN 24 AND 40),
  -- The effect attempt whose readback produced this observation, when it came from a dispatch
  -- rather than a sweep or a webhook-triggered re-read.
  effect_attempt_id TEXT CHECK (
    effect_attempt_id IS NULL OR length(effect_attempt_id) BETWEEN 8 AND 200
  ),
  -- How the read was triggered. A webhook is a trigger, never evidence (section 5.1), so the
  -- provenance is recorded and the observation still only ever comes from an authenticated read.
  source TEXT NOT NULL CHECK (source IN ('dispatch_readback', 'webhook_triggered_read', 'sweep', 'recovery_query')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),

  -- The same read, repeated, is one observation. A genuinely later read has a later `read_at` and
  -- becomes a new row even when the facts are identical, which is what makes drift detectable.
  UNIQUE (tenant_id, realm_id, entity_type, entity_id, observed_sha256, read_at),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_observations_entity
  ON accounting_observations (tenant_id, realm_id, entity_type, entity_id, observation_seq);
CREATE INDEX idx_accounting_observations_intent
  ON accounting_observations (tenant_id, intent_id, observation_seq);

CREATE TRIGGER accounting_observations_append_only_update
BEFORE UPDATE ON accounting_observations BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only');
END;
CREATE TRIGGER accounting_observations_append_only_delete
BEFORE DELETE ON accounting_observations BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only');
END;

-- One row per settlement link an observed Payment declares. The cumulative invariant of section
-- 5.4 - sum(linked payment amounts for invoice) <= invoice TotalAmt at intent time - is a SUM over
-- these rows restricted to current observations, so it is arithmetic over recorded facts rather
-- than a number a handler computed and stored.
CREATE TABLE accounting_observation_links (
  link_id TEXT PRIMARY KEY CHECK (length(link_id) = 36),
  observation_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  realm_id TEXT NOT NULL CHECK (length(realm_id) BETWEEN 1 AND 32),
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  linked_txn_type TEXT NOT NULL CHECK (linked_txn_type IN (
    'Invoice', 'CreditMemo', 'Payment', 'RefundReceipt', 'JournalEntry', 'Deposit', 'Estimate'
  )),
  linked_txn_id TEXT NOT NULL CHECK (
    length(linked_txn_id) BETWEEN 1 AND 32 AND linked_txn_id NOT GLOB '*[^0-9]*'
  ),
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  UNIQUE (observation_id, line_index, linked_txn_type, linked_txn_id),
  FOREIGN KEY (observation_id)
    REFERENCES accounting_observations(observation_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_observation_links_target
  ON accounting_observation_links (tenant_id, realm_id, linked_txn_type, linked_txn_id);

CREATE TRIGGER accounting_observation_links_append_only_update
BEFORE UPDATE ON accounting_observation_links BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only');
END;
CREATE TRIGGER accounting_observation_links_append_only_delete
BEFORE DELETE ON accounting_observation_links BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only');
END;

-- The verdict binding one intent to one observation (section 4.2). Append-only: a later read
-- produces a later verdict, and the history of what was decided when stays readable.
CREATE TABLE accounting_reconciliations (
  reconciliation_id TEXT PRIMARY KEY CHECK (length(reconciliation_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  -- NULL for `not_found`: there is no fact set to point at, and inventing an empty observation
  -- would make a missing entity look like an observed one.
  observation_id TEXT,
  expected_sha256 TEXT NOT NULL CHECK (
    length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observed_sha256 TEXT CHECK (
    observed_sha256 IS NULL OR (
      length(observed_sha256) = 64 AND observed_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  -- Section 5.3. `unavailable` is absent by design: the provider being unreachable is not a
  -- statement about the money, so it is never written as a verdict of record.
  verdict TEXT NOT NULL CHECK (verdict IN (
    'reconciled', 'partially_settled', 'mismatch', 'identity_conflict', 'not_found'
  )),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 80),
  -- Cumulative settled amount at this verdict, as a TEXT decimal.
  settled_amount TEXT CHECK (
    settled_amount IS NULL OR (
      length(settled_amount) BETWEEN 4 AND 14
      AND settled_amount NOT GLOB '*[^0-9.-]*'
      AND substr(settled_amount, -3, 1) = '.'
      AND length(settled_amount) - length(replace(settled_amount, '.', '')) = 1
    )
  ),
  resolved_by_user_id TEXT,
  decided_at TEXT NOT NULL CHECK (length(decided_at) BETWEEN 24 AND 40),

  -- One verdict per (intent, observation): reconciling the same read twice is idempotent, and a
  -- new read is a new observation and therefore a new verdict.
  UNIQUE (tenant_id, intent_id, observation_id),
  CHECK (verdict = 'not_found' OR observation_id IS NOT NULL),
  CHECK (verdict != 'reconciled' OR observed_sha256 = expected_sha256),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (observation_id)
    REFERENCES accounting_observations(observation_id) ON DELETE RESTRICT,
  FOREIGN KEY (resolved_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_reconciliations_intent
  ON accounting_reconciliations (tenant_id, intent_id, decided_at);

CREATE TRIGGER accounting_reconciliations_append_only_update
BEFORE UPDATE ON accounting_reconciliations BEGIN
  SELECT RAISE(ABORT, 'accounting_reconciliation_append_only');
END;
CREATE TRIGGER accounting_reconciliations_append_only_delete
BEFORE DELETE ON accounting_reconciliations BEGIN
  SELECT RAISE(ABORT, 'accounting_reconciliation_append_only');
END;

-- INSERT-time half of append-only, added after review of PR #73. The reasoning, the real-D1
-- evidence are documented at the foot of `0059_tax_policy_snapshots.sql`. In short: without these,
-- `INSERT OR REPLACE` deletes the conflicting row through SQLite's internal conflict-delete, which
-- does not fire the `BEFORE DELETE` triggers above unless `PRAGMA recursive_triggers` is ON - and
-- it is not, on D1.
--
-- These three carry a second branch that 0059's guards do not need. All three tables are written
-- with `ON CONFLICT ... DO NOTHING` re-records that carry a fresh surrogate id and a fresh
-- `created_at`/`decided_at`, so "the same fact" cannot mean "every column matches"; those columns
-- are excluded from the comparison, and a same-fact collision then takes `RAISE(IGNORE)`, which
-- abandons the incoming row. For the runtime's re-record that is exactly today's silent no-op. For
-- an `OR REPLACE` it means the stored row is never deleted and re-created - which matters most on
-- `accounting_observations`, where supersession is "highest `observation_seq` wins": a replayed old
-- read that came back under a new sequence would become the current observation without a single
-- fact changing.
--
-- `RAISE(IGNORE)` is safe to use here and not in 0059 for one reason worth stating: SQLite leaves
-- the firing order of two triggers of the same kind undefined, so an IGNORE branch can abandon a
-- row before a sibling BEFORE INSERT trigger has run. These three tables have no sibling BEFORE
-- INSERT trigger; `accounting_intent_tax_bindings` does, which is why its guard refuses only.

CREATE TRIGGER accounting_observations_no_insert_replace
BEFORE INSERT ON accounting_observations BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only')
  WHERE EXISTS (
    SELECT 1 FROM accounting_observations o
     WHERE (
             o.observation_seq = NEW.observation_seq
          OR o.observation_id = NEW.observation_id
          OR (o.tenant_id = NEW.tenant_id AND o.realm_id = NEW.realm_id
              AND o.entity_type = NEW.entity_type AND o.entity_id = NEW.entity_id
              AND o.observed_sha256 = NEW.observed_sha256 AND o.read_at = NEW.read_at)
           )
       AND NOT (
             o.tenant_id IS NEW.tenant_id
         AND o.realm_id IS NEW.realm_id
         AND o.entity_type IS NEW.entity_type
         AND o.entity_id IS NEW.entity_id
         AND o.intent_id IS NEW.intent_id
         AND o.facts_json IS NEW.facts_json
         AND o.observed_sha256 IS NEW.observed_sha256
         AND o.total_amount_cents IS NEW.total_amount_cents
         AND o.balance_cents IS NEW.balance_cents
         AND o.unapplied_amount_cents IS NEW.unapplied_amount_cents
         AND o.read_at IS NEW.read_at
         AND o.effect_attempt_id IS NEW.effect_attempt_id
         AND o.source IS NEW.source
       )
  );
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM accounting_observations o
     WHERE o.observation_seq = NEW.observation_seq
        OR o.observation_id = NEW.observation_id
        OR (o.tenant_id = NEW.tenant_id AND o.realm_id = NEW.realm_id
            AND o.entity_type = NEW.entity_type AND o.entity_id = NEW.entity_id
            AND o.observed_sha256 = NEW.observed_sha256 AND o.read_at = NEW.read_at)
  );
END;

CREATE TRIGGER accounting_observation_links_no_insert_replace
BEFORE INSERT ON accounting_observation_links BEGIN
  SELECT RAISE(ABORT, 'accounting_observation_append_only')
  WHERE EXISTS (
    SELECT 1 FROM accounting_observation_links l
     WHERE (
             l.link_id = NEW.link_id
          OR (l.observation_id = NEW.observation_id AND l.line_index = NEW.line_index
              AND l.linked_txn_type = NEW.linked_txn_type AND l.linked_txn_id = NEW.linked_txn_id)
           )
       AND NOT (
             l.observation_id IS NEW.observation_id
         AND l.tenant_id IS NEW.tenant_id
         AND l.realm_id IS NEW.realm_id
         AND l.line_index IS NEW.line_index
         AND l.linked_txn_type IS NEW.linked_txn_type
         AND l.linked_txn_id IS NEW.linked_txn_id
         AND l.amount_cents IS NEW.amount_cents
       )
  );
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM accounting_observation_links l
     WHERE l.link_id = NEW.link_id
        OR (l.observation_id = NEW.observation_id AND l.line_index = NEW.line_index
            AND l.linked_txn_type = NEW.linked_txn_type AND l.linked_txn_id = NEW.linked_txn_id)
  );
END;

-- `UNIQUE (tenant_id, intent_id, observation_id)` does not constrain the `not_found` rows, whose
-- `observation_id` is NULL: SQLite treats NULLs in a unique index as distinct. The `=` comparison
-- below mirrors that exactly - a NULL never matches, so a `not_found` verdict never collides and
-- the guard stays a faithful reading of the index rather than a stricter rule of its own.
CREATE TRIGGER accounting_reconciliations_no_insert_replace
BEFORE INSERT ON accounting_reconciliations BEGIN
  SELECT RAISE(ABORT, 'accounting_reconciliation_append_only')
  WHERE EXISTS (
    SELECT 1 FROM accounting_reconciliations r
     WHERE (
             r.reconciliation_id = NEW.reconciliation_id
          OR (r.tenant_id = NEW.tenant_id AND r.intent_id = NEW.intent_id
              AND r.observation_id = NEW.observation_id)
           )
       AND NOT (
             r.tenant_id IS NEW.tenant_id
         AND r.intent_id IS NEW.intent_id
         AND r.observation_id IS NEW.observation_id
         AND r.expected_sha256 IS NEW.expected_sha256
         AND r.observed_sha256 IS NEW.observed_sha256
         AND r.verdict IS NEW.verdict
         AND r.reason_code IS NEW.reason_code
         AND r.settled_amount IS NEW.settled_amount
         AND r.resolved_by_user_id IS NEW.resolved_by_user_id
       )
  );
  SELECT RAISE(IGNORE)
  WHERE EXISTS (
    SELECT 1 FROM accounting_reconciliations r
     WHERE r.reconciliation_id = NEW.reconciliation_id
        OR (r.tenant_id = NEW.tenant_id AND r.intent_id = NEW.intent_id
            AND r.observation_id = NEW.observation_id)
  );
END;
