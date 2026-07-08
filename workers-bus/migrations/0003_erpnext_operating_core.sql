-- 0003_erpnext_operating_core.sql - proof fields for ERPNext property/job handoff.

ALTER TABLE envelopes ADD COLUMN erpnext_roofing_property_id TEXT;
ALTER TABLE envelopes ADD COLUMN erpnext_roof_job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_env_erpnext_roof_job ON envelopes (erpnext_roof_job_id);
