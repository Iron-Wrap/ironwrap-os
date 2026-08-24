-- 0120_production_gate_clearance_scope.sql
-- A clearance decision is idempotent inside one tenant/job/gate aggregate, not globally.
-- Keep the recovery-inventory name stable while narrowing the uniqueness boundary to the
-- same scoped identity used by the immutable R2 receipt key.

DROP INDEX IF EXISTS operating_production_gates_clearance_decision_uidx;

CREATE UNIQUE INDEX operating_production_gates_clearance_decision_uidx
  ON operating_production_gates (
    tenant_id,
    roof_job_id,
    gate,
    clearance_decision_id
  )
  WHERE clearance_decision_id IS NOT NULL;
