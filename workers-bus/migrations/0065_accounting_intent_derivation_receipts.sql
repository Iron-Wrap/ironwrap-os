-- 0065_accounting_intent_derivation_receipts.sql - the receipt the derive route never had.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 8.1. ELEC-77 defect 2: `POST
-- /api/v1/accounting/intents` required an `Idempotency-Key` header and then never referenced it
-- again. Section 8.1 puts that header on every command because a retried money request must not
-- become a second money request, and `approve`/`reject`/`reconcile`/`compensate` honour it through
-- `accounting_intent_command_receipts` - but the one route that *creates* the amounts only checked
-- that the header was present. Replaying a key with a different body derived a second intent.
--
-- Derivation is already idempotent on `basis_sha256`, and that is a different guarantee: it makes
-- the same figures converge on one intent, and says nothing about one key standing for two
-- different sets of figures. The header is the caller's claim that this is the same request; this
-- table is what makes the claim checkable.
--
-- A table of its own rather than a fifth `operation` on `accounting_intent_command_receipts`:
-- that table's AFTER INSERT trigger *is* the command - it validates the actor, the requested
-- version and the source state, then applies a transition. A derivation has no prior version and
-- no source state, so it would have to be special-cased out of every branch of a trigger whose
-- whole point is that no row escapes it. It also carries a foreign key to an intent that does not
-- exist yet at the moment a derivation starts.
--
-- Fresh number: `main` carries through `0062`, this branch adds `0063` and `0064`, and no other
-- open PR head (#72, #71, #70, #60, #22) reaches past `0057`, so this takes `0065` (project
-- rule 4). Additive only - no shipped migration is edited and no existing column changes.

CREATE TABLE accounting_intent_derivation_receipts (
  receipt_id TEXT PRIMARY KEY CHECK (length(receipt_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  -- What the key derived. The row is written after the derivation, because the intent id is
  -- computed from the bound basis and the foreign key below has to point at a row that exists.
  intent_id TEXT NOT NULL,
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- The normalized derivation request, hashed. Same key and same fingerprint is a replay; same key
  -- and a different fingerprint is a second set of figures wearing the first request's key, and is
  -- refused rather than answered with either one.
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- Who derived, from the session. The same attribution `accounting_intents.derived_by_user_id`
  -- carries, so a receipt is readable evidence on its own.
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),
  UNIQUE (tenant_id, idempotency_key_sha256),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_intent_derivation_receipts_intent
  ON accounting_intent_derivation_receipts (tenant_id, intent_id, created_at);

CREATE TRIGGER accounting_intent_derivation_receipts_append_only_update
BEFORE UPDATE ON accounting_intent_derivation_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_derivation_receipts_append_only');
END;

CREATE TRIGGER accounting_intent_derivation_receipts_append_only_delete
BEFORE DELETE ON accounting_intent_derivation_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_derivation_receipts_append_only');
END;

-- The `INSERT OR REPLACE` half of append-only, per 0062: `OR REPLACE` resolves a UNIQUE conflict by
-- deleting the conflicting row internally, and an internal delete fires DELETE triggers only under
-- `PRAGMA recursive_triggers`, which is off by default on D1. Without this guard a forged
-- `REPLACE INTO` could rewrite which intent a key stands for - which is the whole content of the
-- record. The handler reads the receipt before it inserts and treats any collision as a replay or a
-- conflict, so this changes which error a colliding insert raises, never whether one is raised.
CREATE TRIGGER accounting_intent_derivation_receipts_no_insert_replace
BEFORE INSERT ON accounting_intent_derivation_receipts BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_derivation_receipt_exists')
  WHERE EXISTS (
    SELECT 1 FROM accounting_intent_derivation_receipts r
     WHERE r.receipt_id = NEW.receipt_id
        OR (r.tenant_id = NEW.tenant_id
            AND r.idempotency_key_sha256 = NEW.idempotency_key_sha256)
  );
END;
