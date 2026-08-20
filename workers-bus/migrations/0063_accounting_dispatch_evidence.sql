-- 0063_accounting_dispatch_evidence.sql - the two records a production dispatch needs.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md sections 5.1, 5.4 and 8.1. Slices S1-S5 built the
-- money engine and S8 built the routes, but nothing joined them: an approved intent stopped at
-- `submission_pending` and an authorized compensation stopped at `compensating`, because the two
-- facts a background dispatcher needs to act on an accountant's decision were never written down.
-- This migration writes them down. It is additive only - no shipped migration is edited, no column
-- of `accounting_intents` changes, and both tables are append-only.
--
-- Fresh numbers: `main` and every open PR head carry through `0062`, so this takes `0063`
-- (project rule 4).
--
-- **1. `accounting_intent_expectations`.** `accounting_intents.expected_sha256` is a hash, and the
-- envelope it was taken over is not stored anywhere. `submitAccountingIntent` requires that exact
-- envelope, so only a caller that had just built it could dispatch - which is precisely why the
-- only caller was a test. Storing the envelope makes dispatch a background job's work.
--
-- `omits_identity` records the second thing, and this one is a correctness fix rather than
-- plumbing. Section 5.2 puts the provider's `Id` inside the hashed comparison fact set, and a
-- create does not know its `Id` until Intuit assigns one - so an intent for an entity IronWrap is
-- about to create can never bind a reconcilable `expected_sha256` at derivation. Completing it
-- afterwards is not available either: `expected_sha256` is immutable, and `accounting_intents`
-- CHECKs that a row in `reconciled` has `observed_sha256 = expected_sha256`.
--
-- So such an intent binds an identity-free expectation, and the observation it is judged against is
-- hashed on the same basis. That is not a weakening of section 5.1: the sentence also requires
-- provider identity to equal "the identity recorded on the settled effect attempt", which
-- `accounting-reconciliation.ts` already checks directly - realm, entity type and entity id -
-- before any hash is compared. Hashing the id as well stated that check twice and made the create
-- case impossible. An intent that bound a complete envelope, which is every intent that exists
-- today, has `omits_identity = 0` and is compared exactly as before.
--
-- **2. `accounting_compensation_authorizations`.** `POST /compensate` computed a plan, returned it
-- to the browser, and persisted nothing but a receipt fingerprint - so the amount and remedy the
-- accountant authorized were unrecoverable the moment the response was sent, and no later process
-- could dispatch the reversal they asked for. The authorization is a money decision under section
-- 6; it is now evidence with a row of its own, and it is what the exception-resolution check
-- measures a claimed reversal against.

CREATE TABLE accounting_intent_expectations (
  expectation_id TEXT PRIMARY KEY CHECK (length(expectation_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL CHECK (length(envelope_json) BETWEEN 2 AND 32768),
  expected_sha256 TEXT NOT NULL CHECK (
    length(expected_sha256) = 64 AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  -- 1 when the bound fact set names no provider `Id`, because IronWrap is creating the entity.
  omits_identity INTEGER NOT NULL CHECK (omits_identity IN (0, 1)),
  bound_at TEXT NOT NULL CHECK (length(bound_at) BETWEEN 24 AND 40),
  -- One envelope per intent. Derivation is idempotent on the basis hash, so a re-derivation has to
  -- be a storage-layer no-op rather than a second envelope a reader would have to choose between.
  UNIQUE (tenant_id, intent_id),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_intent_expectations_intent
  ON accounting_intent_expectations (tenant_id, intent_id);

CREATE TRIGGER accounting_intent_expectations_append_only_update
BEFORE UPDATE ON accounting_intent_expectations BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_expectations_append_only');
END;

CREATE TRIGGER accounting_intent_expectations_append_only_delete
BEFORE DELETE ON accounting_intent_expectations BEGIN
  SELECT RAISE(ABORT, 'accounting_intent_expectations_append_only');
END;

-- The accountant's authorization of one reversal, in the numbers they authorized it in.
--
-- `reversal_intent_id` is minted by the route that records the authorization, so the dispatcher
-- looks up exactly one reversal for exactly one authorization and a replayed command cannot
-- produce a second reversing intent for the same exception.
CREATE TABLE accounting_compensation_authorizations (
  authorization_id TEXT PRIMARY KEY CHECK (length(authorization_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  -- The intent being reversed.
  intent_id TEXT NOT NULL,
  exception_id TEXT NOT NULL,
  reversal_intent_id TEXT NOT NULL,
  remedy TEXT NOT NULL CHECK (remedy IN ('credit_memo_issued', 'refund_issued')),
  reversal_kind TEXT NOT NULL CHECK (reversal_kind IN ('credit_memo', 'refund')),
  -- Negative, two decimal places: a reversal moves money the other way (section 4.1).
  total_amount TEXT NOT NULL CHECK (
    length(total_amount) BETWEEN 5 AND 15
    AND substr(total_amount, 1, 1) = '-'
    AND substr(total_amount, -3, 1) = '.'
  ),
  -- The magnitude, which is the only scale a money ceiling is ever compared on (section 6).
  magnitude_amount TEXT NOT NULL CHECK (
    length(magnitude_amount) BETWEEN 4 AND 14
    AND substr(magnitude_amount, -3, 1) = '.'
    AND instr(magnitude_amount, '-') = 0
  ),
  plan_json TEXT NOT NULL CHECK (length(plan_json) BETWEEN 2 AND 8192),
  authorized_by_user_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL CHECK (length(authorized_at) BETWEEN 24 AND 40),
  -- One live authorization per exception. A retried command replays it rather than authorizing a
  -- second reversal for money that is only owed back once.
  UNIQUE (tenant_id, exception_id),
  UNIQUE (tenant_id, reversal_intent_id),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (authorized_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_compensation_authorizations_intent
  ON accounting_compensation_authorizations (tenant_id, intent_id, authorized_at);

CREATE TRIGGER accounting_compensation_authorizations_append_only_update
BEFORE UPDATE ON accounting_compensation_authorizations BEGIN
  SELECT RAISE(ABORT, 'accounting_compensation_authorizations_append_only');
END;

CREATE TRIGGER accounting_compensation_authorizations_append_only_delete
BEFORE DELETE ON accounting_compensation_authorizations BEGIN
  SELECT RAISE(ABORT, 'accounting_compensation_authorizations_append_only');
END;
