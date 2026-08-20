-- 0064_accounting_authority_policy.sql - the tenant's money ceiling, owned by the server.
--
-- docs/ACCOUNTING-RECONCILIATION-CONTRACT.md section 6. ELEC-73 finding 2: `POST
-- /api/v1/accounting/intents` read `authority_max_amount` straight off the request body and passed
-- it through unchanged, so the only ceiling check in the money plane
-- (`|total_amount| > |authority_max_amount|`) compared two numbers that came from the same
-- untrusted request. A caller could always satisfy it by declaring a bigger ceiling. Section 6
-- calls this the control that "gates hardest"; a caller-declared value is not a gate.
--
-- This table is where the ceiling comes from instead. It is deliberately small - one amount per
-- tenant, optionally narrowed per intent kind - because the decision this slice implements is
-- "the server owns the number", not "IronWrap grows a policy engine".
--
-- **Append-only and versioned**, following `0059_tax_policy_snapshots.sql` rather than a mutable
-- settings row: a ceiling that can be silently edited is only marginally harder to move than one
-- the caller declares, and section 6 wants the money controls auditable. Raising a ceiling is a
-- new row naming who raised it and from when; the old row stays readable, so an intent derived
-- last month can still be explained by the ceiling that was in force when it was derived.
--
-- A tenant with no row at all is not unconfigured-and-therefore-unlimited: the reader falls back to
-- a conservative platform default (`DEFAULT_ACCOUNTING_AUTHORITY_MAX_AMOUNT`,
-- `accounting-authority-policy.ts`). Fail-closed is the only safe direction for a ceiling.
--
-- Fresh number: `main` carries through `0062`, this branch adds `0063`, and no other open PR head
-- (#72, #71, #70, #60, #22) reaches past `0057`, so this takes `0064` (project rule 4). Additive
-- only - no shipped migration is edited and no existing column changes.

CREATE TABLE accounting_authority_policies (
  policy_id TEXT PRIMARY KEY CHECK (length(policy_id) = 36),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64),
  -- The intent kind this ceiling governs, or '*' for the tenant-wide default. The kind list is
  -- `ACCOUNTING_INTENT_KINDS`; a kind-specific row wins over '*' for that kind.
  kind TEXT NOT NULL CHECK (kind IN (
    '*', 'deposit_invoice', 'progress_invoice', 'payment', 'credit_memo', 'refund',
    'holdback_release', 'tax_remittance_proposal', 'payroll_journal'
  )),
  -- Positive, two decimal places. A ceiling is a magnitude: section 4.1 makes credit memos and
  -- refunds negative, and section 6 gates them on the absolute value, so a signed ceiling here
  -- would be a ceiling that exempts exactly the kinds it exists for.
  max_amount TEXT NOT NULL CHECK (
    length(max_amount) BETWEEN 4 AND 14
    AND substr(max_amount, -3, 1) = '.'
    AND instr(max_amount, '-') = 0
    AND max_amount NOT GLOB '*[^0-9.]*'
  ),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 32),
  effective_from TEXT NOT NULL CHECK (length(effective_from) = 10),
  -- Where the number came from: the owner decision, board resolution, or insurance limit that set
  -- it. Section 6 admits identifiers into evidence, so this is a reference, never a document body.
  source_ref TEXT NOT NULL CHECK (length(source_ref) BETWEEN 2 AND 200),
  -- Null for a platform-seeded row; a real user for one an owner recorded.
  recorded_by_user_id TEXT,
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 24 AND 40),
  -- One row per version of one ceiling. A replayed write is a no-op rather than a second row a
  -- reader would have to choose between.
  UNIQUE (tenant_id, kind, policy_version),
  FOREIGN KEY (recorded_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

-- The read the derive route performs on every derivation: newest in-force row for this tenant and
-- kind.
CREATE INDEX idx_accounting_authority_policies_effective
  ON accounting_authority_policies (tenant_id, kind, effective_from, recorded_at);

CREATE TRIGGER accounting_authority_policies_append_only_update
BEFORE UPDATE ON accounting_authority_policies BEGIN
  SELECT RAISE(ABORT, 'accounting_authority_policies_append_only');
END;

CREATE TRIGGER accounting_authority_policies_append_only_delete
BEFORE DELETE ON accounting_authority_policies BEGIN
  SELECT RAISE(ABORT, 'accounting_authority_policies_append_only');
END;
