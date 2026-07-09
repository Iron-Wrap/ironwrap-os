-- 0002_erpnext_consumer.sql - proof fields for the optional ERPNext Lead Envelope consumer.

ALTER TABLE envelopes ADD COLUMN erpnext_lead_envelope_id TEXT;
ALTER TABLE envelopes ADD COLUMN erpnext_synced_at TEXT;
ALTER TABLE envelopes ADD COLUMN erpnext_error TEXT;
CREATE INDEX IF NOT EXISTS idx_env_erpnext ON envelopes (erpnext_lead_envelope_id);
