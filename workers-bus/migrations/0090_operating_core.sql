-- 0090_operating_core.sql - tenant-owned D1 operating-core facts.
--
-- The inbound envelope and its raw R2 object remain the source evidence.  These tables contain
-- only the validated facts needed by the owned operating surface and the temporary Frappe
-- projection.  Provider payloads are deliberately not copied here.

CREATE TABLE IF NOT EXISTS operating_leads (
  lead_id TEXT PRIMARY KEY CHECK (
    length(lead_id) BETWEEN 8 AND 200
    AND lead_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  source TEXT NOT NULL CHECK (source IN ('website', 'phone', 'gbp', 'ad', 'referral', 'manual')),
  contact_name TEXT CHECK (contact_name IS NULL OR length(trim(contact_name)) BETWEEN 1 AND 160),
  contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 7 AND 24),
  contact_email TEXT CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  job_ref TEXT CHECK (job_ref IS NULL OR length(trim(job_ref)) BETWEEN 1 AND 160),
  lifecycle_status TEXT NOT NULL DEFAULT 'untriaged' CHECK (
    lifecycle_status IN ('untriaged', 'triaged', 'qualified', 'disqualified', 'converted')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (lead_id, tenant_id),
  UNIQUE (tenant_id, source_envelope_id),
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_leads_tenant_status
  ON operating_leads (tenant_id, lifecycle_status, updated_at DESC);

CREATE TABLE IF NOT EXISTS operating_customers (
  customer_id TEXT PRIMARY KEY CHECK (
    length(customer_id) BETWEEN 8 AND 200
    AND customer_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 160),
  contact_phone TEXT CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 7 AND 24),
  contact_email TEXT CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  lifecycle_status TEXT NOT NULL DEFAULT 'prospect' CHECK (
    lifecycle_status IN ('prospect', 'active', 'archived')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (customer_id, tenant_id),
  UNIQUE (tenant_id, contact_phone),
  UNIQUE (tenant_id, contact_email),
  CHECK (contact_phone IS NOT NULL OR contact_email IS NOT NULL),
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_customers_tenant_contact
  ON operating_customers (tenant_id, contact_email, contact_phone);

CREATE TABLE IF NOT EXISTS operating_properties (
  property_id TEXT PRIMARY KEY CHECK (
    length(property_id) BETWEEN 8 AND 200
    AND property_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  property_key TEXT NOT NULL CHECK (length(trim(property_key)) BETWEEN 1 AND 180),
  lead_id TEXT NOT NULL,
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  address_line1 TEXT,
  city TEXT,
  province TEXT,
  postal_code TEXT,
  country TEXT NOT NULL DEFAULT 'Canada',
  service_area TEXT,
  structure_type TEXT,
  roof_notes TEXT,
  hazard_notes TEXT,
  verification_status TEXT NOT NULL DEFAULT 'unverified' CHECK (
    verification_status IN ('unverified', 'reviewed', 'verified', 'rejected')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (property_id, tenant_id),
  UNIQUE (tenant_id, property_key),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES operating_leads(lead_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_properties_tenant_address
  ON operating_properties (tenant_id, city, postal_code);

CREATE TABLE IF NOT EXISTS operating_roof_jobs (
  roof_job_id TEXT PRIMARY KEY CHECK (
    length(roof_job_id) BETWEEN 8 AND 200
    AND roof_job_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  lead_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  property_id TEXT,
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  brand TEXT CHECK (brand IS NULL OR brand IN ('ironwrap', 'iroof')),
  job_number TEXT,
  service_type TEXT NOT NULL CHECK (length(trim(service_type)) BETWEEN 1 AND 80),
  jobnimbus_contact_id TEXT,
  jobnimbus_job_id TEXT,
  job_status TEXT NOT NULL DEFAULT 'qualified' CHECK (
    job_status IN ('qualified', 'in_progress', 'complete', 'cancelled')
  ),
  current_gate_state TEXT NOT NULL DEFAULT 'qualification' CHECK (
    current_gate_state IN ('qualification', 'blocked', 'ready', 'in_progress', 'complete')
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (roof_job_id, tenant_id),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES operating_leads(lead_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id) REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (property_id, tenant_id) REFERENCES operating_properties(property_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_roof_jobs_tenant_status
  ON operating_roof_jobs (tenant_id, job_status, current_gate_state, updated_at DESC);

CREATE TABLE IF NOT EXISTS operating_production_gates (
  gate_id TEXT PRIMARY KEY CHECK (
    length(gate_id) BETWEEN 8 AND 240
    AND gate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL,
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  gate TEXT NOT NULL CHECK (gate IN ('Deposit', 'Materials', 'Safety', 'Access', 'Weather', 'Crew', 'Completion')),
  state TEXT NOT NULL DEFAULT 'blocked' CHECK (state IN ('blocked', 'ready', 'in_progress', 'complete', 'waived')),
  owner_user TEXT NOT NULL CHECK (length(trim(owner_user)) BETWEEN 1 AND 160),
  assigned_at TEXT NOT NULL CHECK (length(assigned_at) BETWEEN 20 AND 40),
  due_at TEXT NOT NULL CHECK (length(due_at) BETWEEN 20 AND 40),
  blocker_reason TEXT NOT NULL CHECK (length(trim(blocker_reason)) BETWEEN 1 AND 240),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (gate_id, tenant_id),
  UNIQUE (tenant_id, roof_job_id, gate),
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_gates_tenant_state
  ON operating_production_gates (tenant_id, state, due_at);

CREATE TABLE IF NOT EXISTS operating_instant_estimates (
  estimate_session_id TEXT PRIMARY KEY CHECK (
    length(estimate_session_id) BETWEEN 8 AND 240
    AND estimate_session_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  lead_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  source TEXT NOT NULL CHECK (source IN ('website', 'phone', 'gbp', 'ad', 'referral', 'manual')),
  service_type TEXT NOT NULL CHECK (length(trim(service_type)) BETWEEN 1 AND 80),
  status TEXT NOT NULL CHECK (status IN ('captured', 'needs_review', 'approved', 'rejected')),
  range_low_cents INTEGER CHECK (
    range_low_cents IS NULL OR (typeof(range_low_cents) = 'integer' AND range_low_cents >= 0)
  ),
  range_high_cents INTEGER CHECK (
    range_high_cents IS NULL OR (typeof(range_high_cents) = 'integer' AND range_high_cents >= 0)
  ),
  estimate_total_cents INTEGER CHECK (
    estimate_total_cents IS NULL OR (typeof(estimate_total_cents) = 'integer' AND estimate_total_cents >= 0)
  ),
  configurator_url TEXT,
  confidence TEXT,
  review_required INTEGER NOT NULL DEFAULT 1 CHECK (review_required IN (0, 1)),
  assumptions TEXT,
  exclusions TEXT,
  selected_services_json TEXT CHECK (
    selected_services_json IS NULL OR (length(selected_services_json) BETWEEN 2 AND 16384 AND json_valid(selected_services_json))
  ),
  material_choices_json TEXT CHECK (
    material_choices_json IS NULL OR (length(material_choices_json) BETWEEN 2 AND 16384 AND json_valid(material_choices_json))
  ),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (estimate_session_id, tenant_id),
  CHECK (range_low_cents IS NULL OR range_high_cents IS NULL OR range_low_cents <= range_high_cents),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES operating_leads(lead_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_estimates_tenant_status
  ON operating_instant_estimates (tenant_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS operating_consents (
  consent_id TEXT PRIMARY KEY CHECK (
    length(consent_id) BETWEEN 8 AND 240
    AND consent_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  lead_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT NOT NULL CHECK (length(trim(source_raw_key)) BETWEEN 1 AND 280),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'phone')),
  purpose TEXT NOT NULL CHECK (purpose = 'estimate_follow_up'),
  status TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'revoked')),
  jurisdiction TEXT NOT NULL CHECK (length(trim(jurisdiction)) BETWEEN 2 AND 120),
  consent_basis TEXT NOT NULL CHECK (consent_basis = 'express'),
  captured_by TEXT NOT NULL CHECK (length(trim(captured_by)) BETWEEN 1 AND 160),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (consent_id, tenant_id),
  UNIQUE (tenant_id, lead_id, channel, purpose),
  FOREIGN KEY (lead_id, tenant_id) REFERENCES operating_leads(lead_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (customer_id, tenant_id) REFERENCES operating_customers(customer_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (roof_job_id, tenant_id) REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_consents_tenant_customer
  ON operating_consents (tenant_id, customer_id, purpose, channel);

CREATE TABLE IF NOT EXISTS operating_core_events (
  event_id TEXT PRIMARY KEY CHECK (
    length(event_id) BETWEEN 12 AND 260
    AND event_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  event_type TEXT NOT NULL CHECK (event_type = 'operating_core_materialized'),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('lead', 'customer', 'property', 'roof_job', 'production_gate', 'instant_estimate', 'consent')),
  entity_id TEXT NOT NULL,
  details_json TEXT NOT NULL CHECK (length(details_json) BETWEEN 2 AND 8192 AND json_valid(details_json)),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (event_id, tenant_id),
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_events_tenant_time
  ON operating_core_events (tenant_id, occurred_at, event_id);

CREATE TABLE IF NOT EXISTS operating_core_audit (
  audit_id TEXT PRIMARY KEY CHECK (
    length(audit_id) BETWEEN 12 AND 260
    AND audit_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  source_envelope_id TEXT NOT NULL,
  source_raw_key TEXT CHECK (source_raw_key IS NULL OR length(trim(source_raw_key)) BETWEEN 1 AND 280),
  action TEXT NOT NULL CHECK (action = 'materialize'),
  result TEXT NOT NULL CHECK (result = 'ok'),
  target_ids_json TEXT NOT NULL CHECK (length(target_ids_json) BETWEEN 2 AND 8192 AND json_valid(target_ids_json)),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (audit_id, tenant_id),
  FOREIGN KEY (source_envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_operating_audit_tenant_time
  ON operating_core_audit (tenant_id, created_at, audit_id);

-- Mutable facts use a monotonic version.  The materializer inserts missing rows and never updates
-- them, so a retry cannot reset a human decision.  Future human writes must opt into CAS semantics.
CREATE TRIGGER IF NOT EXISTS operating_leads_version_guard
BEFORE UPDATE ON operating_leads
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_leads_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_customers_version_guard
BEFORE UPDATE ON operating_customers
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_customers_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_properties_version_guard
BEFORE UPDATE ON operating_properties
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_properties_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_roof_jobs_version_guard
BEFORE UPDATE ON operating_roof_jobs
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_roof_jobs_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_production_gates_version_guard
BEFORE UPDATE ON operating_production_gates
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_production_gates_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_instant_estimates_version_guard
BEFORE UPDATE ON operating_instant_estimates
WHEN NEW.version != OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'operating_instant_estimates_version_conflict'); END;

CREATE TRIGGER IF NOT EXISTS operating_leads_identity_guard
BEFORE UPDATE ON operating_leads
WHEN NEW.lead_id != OLD.lead_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.source_envelope_id != OLD.source_envelope_id
  OR NEW.source IS NOT OLD.source
  OR NEW.source_raw_key IS NOT OLD.source_raw_key
BEGIN SELECT RAISE(ABORT, 'operating_leads_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_customers_identity_guard
BEFORE UPDATE ON operating_customers
WHEN NEW.customer_id != OLD.customer_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.source_envelope_id != OLD.source_envelope_id
  OR NEW.source_raw_key IS NOT OLD.source_raw_key
  OR NEW.contact_phone IS NOT OLD.contact_phone
  OR NEW.contact_email IS NOT OLD.contact_email
BEGIN SELECT RAISE(ABORT, 'operating_customers_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_properties_identity_guard
BEFORE UPDATE ON operating_properties
WHEN NEW.property_id != OLD.property_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.property_key != OLD.property_key OR NEW.source_envelope_id != OLD.source_envelope_id
  OR NEW.source_raw_key IS NOT OLD.source_raw_key
BEGIN SELECT RAISE(ABORT, 'operating_properties_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_roof_jobs_identity_guard
BEFORE UPDATE ON operating_roof_jobs
WHEN NEW.roof_job_id != OLD.roof_job_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.lead_id != OLD.lead_id OR NEW.customer_id != OLD.customer_id
  OR NEW.property_id IS NOT OLD.property_id OR NEW.source_envelope_id != OLD.source_envelope_id
  OR NEW.source_raw_key IS NOT OLD.source_raw_key
BEGIN SELECT RAISE(ABORT, 'operating_roof_jobs_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_production_gates_identity_guard
BEFORE UPDATE ON operating_production_gates
WHEN NEW.gate_id != OLD.gate_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.roof_job_id != OLD.roof_job_id OR NEW.gate != OLD.gate
  OR NEW.source_envelope_id != OLD.source_envelope_id
  OR NEW.source_raw_key IS NOT OLD.source_raw_key
BEGIN SELECT RAISE(ABORT, 'operating_production_gates_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_instant_estimates_identity_guard
BEFORE UPDATE ON operating_instant_estimates
WHEN NEW.estimate_session_id != OLD.estimate_session_id OR NEW.tenant_id != OLD.tenant_id
  OR NEW.lead_id != OLD.lead_id OR NEW.roof_job_id != OLD.roof_job_id
  OR NEW.source_envelope_id != OLD.source_envelope_id OR NEW.source_raw_key IS NOT OLD.source_raw_key
  OR NEW.source != OLD.source
BEGIN SELECT RAISE(ABORT, 'operating_instant_estimates_identity_immutable'); END;

CREATE TRIGGER IF NOT EXISTS operating_consents_append_only_update
BEFORE UPDATE ON operating_consents
BEGIN SELECT RAISE(ABORT, 'operating_consents_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_consents_append_only_delete
BEFORE DELETE ON operating_consents
BEGIN SELECT RAISE(ABORT, 'operating_consents_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_core_events_append_only_update
BEFORE UPDATE ON operating_core_events
BEGIN SELECT RAISE(ABORT, 'operating_core_events_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_core_events_append_only_delete
BEFORE DELETE ON operating_core_events
BEGIN SELECT RAISE(ABORT, 'operating_core_events_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_core_audit_append_only_update
BEFORE UPDATE ON operating_core_audit
BEGIN SELECT RAISE(ABORT, 'operating_core_audit_append_only'); END;

CREATE TRIGGER IF NOT EXISTS operating_core_audit_append_only_delete
BEFORE DELETE ON operating_core_audit
BEGIN SELECT RAISE(ABORT, 'operating_core_audit_append_only'); END;
