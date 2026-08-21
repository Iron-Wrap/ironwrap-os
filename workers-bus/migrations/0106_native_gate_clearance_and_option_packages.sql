-- 0106_native_gate_clearance_and_option_packages.sql
-- Persist production-gate clearance on D1 and hold curated option packages
-- without a Frappe write. No FK from option packages to jobs so isolated
-- decision tests can apply this file alone.

ALTER TABLE operating_production_gates ADD COLUMN clearance_basis TEXT
  CHECK (clearance_basis IS NULL OR clearance_basis IN ('office_waiver', 'deposit_settlement'));

ALTER TABLE operating_production_gates ADD COLUMN clearance_decision_id TEXT
  CHECK (
    clearance_decision_id IS NULL OR (
      length(clearance_decision_id) BETWEEN 16 AND 160
      AND clearance_decision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  );

ALTER TABLE operating_production_gates ADD COLUMN cleared_by_user_id TEXT
  CHECK (
    cleared_by_user_id IS NULL OR (
      length(cleared_by_user_id) BETWEEN 8 AND 200
      AND cleared_by_user_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  );

ALTER TABLE operating_production_gates ADD COLUMN evidence_refs_json TEXT
  CHECK (
    evidence_refs_json IS NULL OR (
      length(trim(evidence_refs_json)) BETWEEN 2 AND 4000
      AND substr(trim(evidence_refs_json), 1, 1) IN ('{', '[')
    )
  );

ALTER TABLE operating_production_gates ADD COLUMN cleared_at TEXT
  CHECK (cleared_at IS NULL OR length(cleared_at) BETWEEN 20 AND 40);

CREATE UNIQUE INDEX IF NOT EXISTS operating_production_gates_clearance_decision_uidx
  ON operating_production_gates (clearance_decision_id)
  WHERE clearance_decision_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS operating_option_packages (
  option_id TEXT PRIMARY KEY CHECK (
    length(option_id) BETWEEN 3 AND 140
    AND option_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  job_id TEXT NOT NULL CHECK (length(trim(job_id)) BETWEEN 3 AND 140),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  tier TEXT CHECK (tier IS NULL OR length(trim(tier)) BETWEEN 1 AND 40),
  material_system TEXT CHECK (
    material_system IS NULL OR length(trim(material_system)) BETWEEN 1 AND 200
  ),
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft', 'approved')),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_operating_option_packages_tenant_job
  ON operating_option_packages (tenant_id, job_id, status);
