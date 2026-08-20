-- 0059_tax_policy_snapshots.sql - the IRO-52 versioned tax rate snapshots.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md slice S2. The contract reserved 0061 for this file;
-- that number was chosen on 2026-08-18 against the heads in flight then. Re-verified on
-- 2026-08-20: `main` tops out at 0057, slice S1 shipped 0058, and no open PR head claims 0059,
-- so this slice takes 0059/0060/0061 and the mapping is recorded in the PR body.
--
-- Two tables, one rule: a snapshot is a fact about a rate at a moment, and facts do not change.
-- A rate change creates a new snapshot with a higher version (section 5.4, "tax rate change
-- mid-project"); it never edits the row an already-submitted intent bound. The append-only
-- triggers make that structural rather than a convention a handler could forget.
--
-- Supersession without mutation: `effective_to` is only ever the end date a source *states*. The
-- snapshot that is current at an instant is the highest-versioned row whose window contains it,
-- computed by `currentTaxPolicySnapshot` in `accounting-tax-snapshots.ts`. Closing a window by
-- UPDATE would be an edit to a bound fact, so the schema refuses it outright.
--
-- Cross-plane discipline (contract section 3.1): no foreign key into a 0041 or 0042 table.

CREATE TABLE tax_policy_snapshots (
  snapshot_id TEXT PRIMARY KEY CHECK (
    length(snapshot_id) BETWEEN 16 AND 160
    AND snapshot_id NOT GLOB '*[^A-Za-z0-9:_.-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),

  -- Where the rate is owed. Alberta is 'CA-AB'; the column is a plain jurisdiction code so the
  -- module stays industry- and province-agnostic (project vision: universal modular hub).
  jurisdiction TEXT NOT NULL CHECK (
    length(jurisdiction) BETWEEN 2 AND 32 AND jurisdiction NOT GLOB '*[^A-Z0-9-]*'
  ),
  -- The tax code as the accounting provider names it, e.g. 'GST'. Never invented by an agent:
  -- section 6, "agents may not invent chart-of-accounts, tax, or payroll truth".
  tax_code TEXT NOT NULL CHECK (length(tax_code) BETWEEN 1 AND 64),
  -- The provider's TaxCode/TaxRate id, when the mapping is known. Drift detection reads this id.
  provider_tax_code_id TEXT CHECK (
    provider_tax_code_id IS NULL OR (
      length(provider_tax_code_id) BETWEEN 1 AND 32
      AND provider_tax_code_id NOT GLOB '*[^0-9]*'
    )
  ),

  -- A percentage with exactly four decimal places, never a float: '5.0000' is 5%. Comparisons
  -- cast to an integer of ten-thousandths with replace(x, '.', ''), exact because the CHECK
  -- admits exactly four places. A tax rate is never negative.
  rate_percent TEXT NOT NULL CHECK (
    length(rate_percent) BETWEEN 6 AND 12
    AND rate_percent NOT GLOB '*[^0-9.]*'
    AND substr(rate_percent, -5, 1) = '.'
    AND length(rate_percent) - length(replace(rate_percent, '.', '')) = 1
  ),

  -- Inclusive start, exclusive end. `effective_to` is NULL until a source states an end date.
  effective_from TEXT NOT NULL CHECK (
    length(effective_from) = 10 AND effective_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_to TEXT CHECK (
    effective_to IS NULL OR (
      length(effective_to) = 10 AND effective_to GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
  ),

  -- The statute, bulletin, or provider record the rate was read from. Evidence, not decoration:
  -- section 6 requires the bound tax snapshot as evidence on every tax-bearing transition.
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  -- sha256 over the canonical JSON of the bound facts above. Recomputed and asserted by
  -- `recordTaxPolicySnapshot`, so a row whose hash does not describe it cannot be written twice.
  snapshot_sha256 TEXT NOT NULL CHECK (
    length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 24 AND 40),

  UNIQUE (tenant_id, snapshot_sha256),
  UNIQUE (tenant_id, jurisdiction, tax_code, version),
  UNIQUE (tenant_id, jurisdiction, tax_code, effective_from),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE INDEX idx_tax_policy_snapshots_current
  ON tax_policy_snapshots (tenant_id, jurisdiction, tax_code, effective_from);

-- Immutable. A rate change is a new row, never an edit to the row a submitted intent bound.
CREATE TRIGGER tax_policy_snapshots_immutable_update
BEFORE UPDATE ON tax_policy_snapshots BEGIN
  SELECT RAISE(ABORT, 'tax_policy_snapshot_immutable');
END;
CREATE TRIGGER tax_policy_snapshots_immutable_delete
BEFORE DELETE ON tax_policy_snapshots BEGIN
  SELECT RAISE(ABORT, 'tax_policy_snapshot_immutable');
END;

-- Which snapshots one intent bound. An intent may bind more than one code (GST plus a provincial
-- code), so this is a set; `accounting_intents.tax_policy_snapshot_sha256` is the hash over that
-- set, computed by `taxBindingSetSha256` and asserted against these rows by
-- `assertAccountingIntentTaxBindingIntegrity`.
CREATE TABLE accounting_intent_tax_bindings (
  binding_id TEXT PRIMARY KEY CHECK (length(binding_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  intent_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  snapshot_sha256 TEXT NOT NULL CHECK (
    length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  jurisdiction TEXT NOT NULL CHECK (length(jurisdiction) BETWEEN 2 AND 32),
  tax_code TEXT NOT NULL CHECK (length(tax_code) BETWEEN 1 AND 64),
  bound_at TEXT NOT NULL CHECK (length(bound_at) BETWEEN 24 AND 40),

  UNIQUE (tenant_id, intent_id, tax_code),
  FOREIGN KEY (intent_id) REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  FOREIGN KEY (snapshot_id) REFERENCES tax_policy_snapshots(snapshot_id) ON DELETE RESTRICT
);

CREATE INDEX idx_accounting_intent_tax_bindings_snapshot
  ON accounting_intent_tax_bindings (tenant_id, snapshot_id);

CREATE TRIGGER accounting_intent_tax_bindings_guard
BEFORE INSERT ON accounting_intent_tax_bindings BEGIN
  -- The binding is part of the derived basis, so it may only be written while the intent is still
  -- pre-decision. After approval the bound snapshot set is what was reviewed, and after submission
  -- it is what was posted (section 5.4).
  SELECT RAISE(ABORT, 'accounting_tax_binding_intent_not_bindable')
  WHERE NOT EXISTS (
    SELECT 1 FROM accounting_intents i
     WHERE i.intent_id = NEW.intent_id AND i.tenant_id = NEW.tenant_id
       AND i.state IN ('draft', 'blocked', 'pending_review')
  );

  -- A binding may not describe a snapshot that does not say the same thing. Without this a caller
  -- could bind snapshot A's id while recording snapshot B's hash, and every later staleness and
  -- drift check would compare the wrong pair.
  SELECT RAISE(ABORT, 'accounting_tax_binding_snapshot_mismatch')
  WHERE NOT EXISTS (
    SELECT 1 FROM tax_policy_snapshots s
     WHERE s.snapshot_id = NEW.snapshot_id AND s.tenant_id = NEW.tenant_id
       AND s.snapshot_sha256 = NEW.snapshot_sha256
       AND s.jurisdiction = NEW.jurisdiction AND s.tax_code = NEW.tax_code
  );
END;

CREATE TRIGGER accounting_intent_tax_bindings_append_only_update
BEFORE UPDATE ON accounting_intent_tax_bindings BEGIN
  SELECT RAISE(ABORT, 'accounting_tax_binding_append_only');
END;
CREATE TRIGGER accounting_intent_tax_bindings_append_only_delete
BEFORE DELETE ON accounting_intent_tax_bindings BEGIN
  SELECT RAISE(ABORT, 'accounting_tax_binding_append_only');
END;

-- INSERT-time half of the same guarantee, added after review of PR #73 (Multica ELEC-64/ELEC-65).
--
-- `BEFORE UPDATE`/`BEFORE DELETE` alone do not make a table append-only. `INSERT OR REPLACE` (and
-- its `REPLACE INTO` spelling) resolves a UNIQUE conflict by deleting the conflicting row
-- *internally*, and an internal delete only fires DELETE triggers when `PRAGMA recursive_triggers`
-- is ON. It is OFF by default. Verified against real D1 (workerd via miniflare) on 2026-08-20:
-- `REPLACE INTO tax_policy_snapshots` rewrote a snapshot's `rate_percent` from '5.0000' to
-- '9.9999' with no error, while UPDATE and DELETE aborted as intended.
--
-- The pragma is not the fix. It is per-connection, and this runtime has no connection to hold it
-- on: `env.DB.prepare` is the only surface a Worker has, and a `wrangler d1 execute` or a
-- dashboard console session starts without it. Pinning it would mean prefixing every statement -
-- a convention in code, which is exactly what the immutability claim was supposed not to be.
--
-- So the guard lives in the schema. A BEFORE INSERT trigger fires before conflict resolution,
-- which means it sees the row `OR REPLACE` is about to delete, and can refuse.
--
-- What counts as "the same fact" is stated per table rather than as `NEW.* = OLD.*`, because the
-- runtime's re-records carry a fresh surrogate id and a fresh write timestamp. Comparisons use
-- `IS`, which is NULL-safe; the conflict predicates use `=`, which reproduces SQLite's rule that
-- NULLs in a unique index are distinct.

-- `recordTaxPolicySnapshot` reads by hash and returns the stored row before it ever inserts, so a
-- colliding insert here is never the runtime being idempotent - it is something rewriting a rate.
-- That lets this guard compare every column, `created_at` included, and refuse outright.
CREATE TRIGGER tax_policy_snapshots_no_insert_replace
BEFORE INSERT ON tax_policy_snapshots BEGIN
  SELECT RAISE(ABORT, 'tax_policy_snapshot_immutable')
  WHERE EXISTS (
    SELECT 1 FROM tax_policy_snapshots s
     WHERE (
             s.snapshot_id = NEW.snapshot_id
          OR (s.tenant_id = NEW.tenant_id AND s.snapshot_sha256 = NEW.snapshot_sha256)
          OR (s.tenant_id = NEW.tenant_id AND s.jurisdiction = NEW.jurisdiction
              AND s.tax_code = NEW.tax_code AND s.version = NEW.version)
          OR (s.tenant_id = NEW.tenant_id AND s.jurisdiction = NEW.jurisdiction
              AND s.tax_code = NEW.tax_code AND s.effective_from = NEW.effective_from)
           )
       AND NOT (
             s.snapshot_id IS NEW.snapshot_id
         AND s.tenant_id IS NEW.tenant_id
         AND s.jurisdiction IS NEW.jurisdiction
         AND s.tax_code IS NEW.tax_code
         AND s.provider_tax_code_id IS NEW.provider_tax_code_id
         AND s.rate_percent IS NEW.rate_percent
         AND s.effective_from IS NEW.effective_from
         AND s.effective_to IS NEW.effective_to
         AND s.source_ref IS NEW.source_ref
         AND s.snapshot_sha256 IS NEW.snapshot_sha256
         AND s.version IS NEW.version
         AND s.created_at IS NEW.created_at
       )
  );
END;

-- `binding_id` and `bound_at` are excluded: `bindAccountingIntentTaxSnapshots` re-records with
-- `ON CONFLICT (tenant_id, intent_id, tax_code) DO NOTHING` and a fresh UUID, and that has to stay
-- the silent no-op it is today. Refusal only, with no `RAISE(IGNORE)` branch, because this table
-- already carries `accounting_intent_tax_bindings_guard` on BEFORE INSERT and SQLite leaves the
-- firing order of two triggers of the same kind undefined - an IGNORE here could abandon the row
-- before the bindable-state check ever ran, and silently weaken it. Falling through instead means
-- a same-fact collision still meets that guard, and then the statement's own conflict resolution.
CREATE TRIGGER accounting_intent_tax_bindings_no_insert_replace
BEFORE INSERT ON accounting_intent_tax_bindings BEGIN
  SELECT RAISE(ABORT, 'accounting_tax_binding_append_only')
  WHERE EXISTS (
    SELECT 1 FROM accounting_intent_tax_bindings b
     WHERE (
             b.binding_id = NEW.binding_id
          OR (b.tenant_id = NEW.tenant_id AND b.intent_id = NEW.intent_id
              AND b.tax_code = NEW.tax_code)
           )
       AND NOT (
             b.tenant_id IS NEW.tenant_id
         AND b.intent_id IS NEW.intent_id
         AND b.snapshot_id IS NEW.snapshot_id
         AND b.snapshot_sha256 IS NEW.snapshot_sha256
         AND b.jurisdiction IS NEW.jurisdiction
         AND b.tax_code IS NEW.tax_code
       )
  );
END;
