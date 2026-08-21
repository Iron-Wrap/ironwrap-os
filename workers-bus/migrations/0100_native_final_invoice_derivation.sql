-- 0100_native_final_invoice_derivation.sql - native completion-to-final-invoice source truth.
--
-- A final invoice may be proposed only from a frozen native completion packet, an exact accepted
-- commercial head, a versioned provider mapping, and reconciled prior invoice facts.  These tables
-- retain those inputs and every blocked/derived outcome; Frappe is neither a source nor a fallback.

CREATE TABLE native_completion_packets (
  completion_packet_id TEXT PRIMARY KEY CHECK (
    length(completion_packet_id) BETWEEN 16 AND 160
    AND completion_packet_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  packet_version INTEGER NOT NULL CHECK (packet_version BETWEEN 1 AND 1000000),
  work_package_set_sha256 TEXT NOT NULL CHECK (
    length(work_package_set_sha256) = 64
    AND work_package_set_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  commercial_head_sha256 TEXT NOT NULL CHECK (
    length(commercial_head_sha256) = 64
    AND commercial_head_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  packet_json TEXT NOT NULL CHECK (
    length(packet_json) BETWEEN 2 AND 131072
    AND json_valid(packet_json)
    AND json_extract(packet_json, '$.schema_version') = 1
    AND json_extract(packet_json, '$.tenant_id') = tenant_id
    AND json_extract(packet_json, '$.roof_job_id') = roof_job_id
    AND json_extract(packet_json, '$.work_package_set_sha256') = work_package_set_sha256
    AND json_extract(packet_json, '$.commercial_head_sha256') = commercial_head_sha256
  ),
  packet_sha256 TEXT NOT NULL CHECK (
    length(packet_sha256) = 64 AND packet_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  completed_at TEXT NOT NULL CHECK (length(completed_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, roof_job_id, packet_version),
  UNIQUE (tenant_id, roof_job_id, packet_sha256),
  UNIQUE (completion_packet_id, tenant_id),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX idx_native_completion_packets_job
  ON native_completion_packets (tenant_id, roof_job_id, packet_version DESC);

CREATE TABLE native_final_invoice_provider_bindings (
  provider_binding_id TEXT PRIMARY KEY CHECK (
    length(provider_binding_id) BETWEEN 16 AND 160
    AND provider_binding_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  realm_id TEXT NOT NULL CHECK (
    length(realm_id) BETWEEN 1 AND 32 AND realm_id NOT GLOB '*[^0-9]*'
  ),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  binding_version INTEGER NOT NULL CHECK (binding_version BETWEEN 1 AND 1000000),
  qbo_customer_id TEXT NOT NULL CHECK (
    length(qbo_customer_id) BETWEEN 1 AND 32 AND qbo_customer_id NOT GLOB '*[^0-9]*'
  ),
  qbo_item_id TEXT NOT NULL CHECK (
    length(qbo_item_id) BETWEEN 1 AND 32 AND qbo_item_id NOT GLOB '*[^0-9]*'
  ),
  qbo_tax_code_id TEXT NOT NULL CHECK (
    length(qbo_tax_code_id) BETWEEN 1 AND 32 AND qbo_tax_code_id NOT GLOB '*[^0-9]*'
  ),
  qbo_terms_id TEXT NOT NULL CHECK (
    length(qbo_terms_id) BETWEEN 1 AND 32 AND qbo_terms_id NOT GLOB '*[^0-9]*'
  ),
  jurisdiction TEXT NOT NULL CHECK (
    length(jurisdiction) BETWEEN 2 AND 32
    AND jurisdiction NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tax_code TEXT NOT NULL CHECK (
    length(tax_code) BETWEEN 1 AND 32
    AND tax_code NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  payment_terms_days INTEGER NOT NULL CHECK (payment_terms_days BETWEEN 0 AND 365),
  source_ref TEXT NOT NULL CHECK (length(trim(source_ref)) BETWEEN 8 AND 200),
  source_sha256 TEXT NOT NULL CHECK (
    length(source_sha256) = 64 AND source_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  supersedes_binding_id TEXT,
  correction_reason TEXT CHECK (
    correction_reason IS NULL OR length(trim(correction_reason)) BETWEEN 3 AND 1200
  ),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  UNIQUE (provider_binding_id, tenant_id),
  UNIQUE (tenant_id, roof_job_id, binding_version),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_binding_id, tenant_id)
    REFERENCES native_final_invoice_provider_bindings(provider_binding_id, tenant_id)
    ON DELETE RESTRICT,
  CHECK (
    (binding_version = 1 AND supersedes_binding_id IS NULL AND correction_reason IS NULL)
    OR (
      binding_version > 1
      AND supersedes_binding_id IS NOT NULL
      AND correction_reason IS NOT NULL
    )
  )
);

CREATE INDEX idx_native_final_invoice_provider_bindings_job
  ON native_final_invoice_provider_bindings (
    tenant_id, roof_job_id, binding_version DESC, realm_id
  );

CREATE UNIQUE INDEX idx_native_final_invoice_provider_bindings_predecessor
  ON native_final_invoice_provider_bindings (tenant_id, supersedes_binding_id)
  WHERE supersedes_binding_id IS NOT NULL;

CREATE TABLE native_final_invoice_derivation_observations (
  derivation_observation_id TEXT PRIMARY KEY CHECK (
    length(derivation_observation_id) BETWEEN 16 AND 160
    AND derivation_observation_id NOT GLOB '*[^A-Za-z0-9:_-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  roof_job_id TEXT NOT NULL CHECK (length(roof_job_id) BETWEEN 1 AND 160),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('blocked', 'intent_derived', 'no_balance')),
  blocker_code TEXT CHECK (
    blocker_code IS NULL OR length(blocker_code) BETWEEN 1 AND 80
  ),
  blocker_next_step TEXT CHECK (
    blocker_next_step IS NULL OR length(blocker_next_step) BETWEEN 1 AND 160
  ),
  completion_packet_id TEXT,
  accounting_intent_id TEXT,
  basis_sha256 TEXT CHECK (
    basis_sha256 IS NULL OR (
      length(basis_sha256) = 64 AND basis_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  details_json TEXT NOT NULL CHECK (
    length(details_json) BETWEEN 2 AND 32768 AND json_valid(details_json)
  ),
  observed_at TEXT NOT NULL CHECK (length(observed_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, roof_job_id, input_sha256),
  FOREIGN KEY (roof_job_id, tenant_id)
    REFERENCES operating_roof_jobs(roof_job_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (completion_packet_id, tenant_id)
    REFERENCES native_completion_packets(completion_packet_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (accounting_intent_id)
    REFERENCES accounting_intents(intent_id) ON DELETE RESTRICT,
  CHECK ((blocker_code IS NULL) = (blocker_next_step IS NULL)),
  CHECK (
    (outcome = 'blocked' AND blocker_code IS NOT NULL AND accounting_intent_id IS NULL)
    OR (
      outcome = 'intent_derived'
      AND blocker_code IS NULL
      AND completion_packet_id IS NOT NULL
      AND accounting_intent_id IS NOT NULL
      AND basis_sha256 IS NOT NULL
    )
    OR (
      outcome = 'no_balance'
      AND blocker_code IS NULL
      AND completion_packet_id IS NOT NULL
      AND accounting_intent_id IS NULL
      AND basis_sha256 IS NULL
    )
  )
);

CREATE INDEX idx_native_final_invoice_derivations_job
  ON native_final_invoice_derivation_observations (
    tenant_id, roof_job_id, observed_at DESC
  );

CREATE INDEX idx_native_final_invoice_derivations_blocked
  ON native_final_invoice_derivation_observations (tenant_id, outcome, observed_at DESC)
  WHERE outcome = 'blocked';

CREATE TABLE native_final_invoice_derivation_cursors (
  cursor_name TEXT PRIMARY KEY CHECK (cursor_name = 'scheduled-v1'),
  last_tenant_id TEXT NOT NULL CHECK (
    length(last_tenant_id) BETWEEN 2 AND 64
    AND last_tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  last_roof_job_id TEXT NOT NULL CHECK (length(last_roof_job_id) BETWEEN 1 AND 160),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
);

CREATE TRIGGER native_final_invoice_provider_bindings_validate_insert
BEFORE INSERT ON native_final_invoice_provider_bindings
BEGIN
  SELECT RAISE(ABORT, 'native_final_invoice_provider_binding_chain_invalid')
  WHERE (
    NEW.binding_version = 1
    AND EXISTS (
      SELECT 1 FROM native_final_invoice_provider_bindings current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.roof_job_id = NEW.roof_job_id
         AND NOT EXISTS (
           SELECT 1 FROM native_final_invoice_provider_bindings successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_binding_id = current.provider_binding_id
         )
    )
  ) OR (
    NEW.binding_version > 1
    AND NOT EXISTS (
      SELECT 1 FROM native_final_invoice_provider_bindings current
       WHERE current.tenant_id = NEW.tenant_id
         AND current.roof_job_id = NEW.roof_job_id
         AND current.provider_binding_id = NEW.supersedes_binding_id
         AND current.binding_version + 1 = NEW.binding_version
         AND NOT EXISTS (
           SELECT 1 FROM native_final_invoice_provider_bindings successor
            WHERE successor.tenant_id = current.tenant_id
              AND successor.supersedes_binding_id = current.provider_binding_id
         )
    )
  );
END;

CREATE TRIGGER native_completion_packets_append_only_update
BEFORE UPDATE ON native_completion_packets
BEGIN SELECT RAISE(ABORT, 'native_completion_packets_append_only'); END;

CREATE TRIGGER native_completion_packets_append_only_delete
BEFORE DELETE ON native_completion_packets
BEGIN SELECT RAISE(ABORT, 'native_completion_packets_append_only'); END;

CREATE TRIGGER native_completion_packets_no_insert_replace
BEFORE INSERT ON native_completion_packets
WHEN EXISTS (
  SELECT 1 FROM native_completion_packets existing
   WHERE existing.completion_packet_id = NEW.completion_packet_id
      OR (
        existing.tenant_id = NEW.tenant_id
        AND existing.roof_job_id = NEW.roof_job_id
        AND (
          existing.packet_version = NEW.packet_version
          OR existing.packet_sha256 = NEW.packet_sha256
        )
      )
)
BEGIN SELECT RAISE(ABORT, 'native_completion_packets_append_only'); END;

CREATE TRIGGER native_final_invoice_provider_bindings_append_only_update
BEFORE UPDATE ON native_final_invoice_provider_bindings
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_provider_bindings_append_only'); END;

CREATE TRIGGER native_final_invoice_provider_bindings_append_only_delete
BEFORE DELETE ON native_final_invoice_provider_bindings
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_provider_bindings_append_only'); END;

CREATE TRIGGER native_final_invoice_provider_bindings_no_insert_replace
BEFORE INSERT ON native_final_invoice_provider_bindings
WHEN EXISTS (
  SELECT 1 FROM native_final_invoice_provider_bindings existing
   WHERE existing.provider_binding_id = NEW.provider_binding_id
      OR (
        existing.tenant_id = NEW.tenant_id
        AND existing.roof_job_id = NEW.roof_job_id
        AND existing.binding_version = NEW.binding_version
      )
)
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_provider_bindings_append_only'); END;

CREATE TRIGGER native_final_invoice_derivation_observations_append_only_update
BEFORE UPDATE ON native_final_invoice_derivation_observations
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_derivation_observations_append_only'); END;

CREATE TRIGGER native_final_invoice_derivation_observations_append_only_delete
BEFORE DELETE ON native_final_invoice_derivation_observations
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_derivation_observations_append_only'); END;

CREATE TRIGGER native_final_invoice_derivation_observations_no_insert_replace
BEFORE INSERT ON native_final_invoice_derivation_observations
WHEN EXISTS (
  SELECT 1 FROM native_final_invoice_derivation_observations existing
   WHERE existing.derivation_observation_id = NEW.derivation_observation_id
      OR (
        existing.tenant_id = NEW.tenant_id
        AND existing.roof_job_id = NEW.roof_job_id
        AND existing.input_sha256 = NEW.input_sha256
      )
)
BEGIN SELECT RAISE(ABORT, 'native_final_invoice_derivation_observations_append_only'); END;
