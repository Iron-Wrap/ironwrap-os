-- 0172_newo_tenant_event_admission.sql
-- Trusted tenant identity and immutable acceptance into owned Newo business state.
-- Transport acknowledgement remains receipt.status: a queue error cannot erase an admitted
-- callback. The Worker commits admission, ordered session projection and first callback in one
-- D1 batch. A deferred FK lets the admission precede a first session insert in that batch.
-- No landed 0168 bytes or historical callback/resolution content are rewritten.
--
-- Legacy ownership uses original owned Newo envelopes and corroborated verified native jobs.
-- Callback/response tenant labels and the next caller are never ownership authority. Missing,
-- conflicting or malformed provenance remains explicit and blocks readiness. A later reviewed
-- owner mapping is needed; an incoming event cannot resolve that hold.

ALTER TABLE newo_sessions ADD COLUMN tenant_id TEXT CHECK (
  tenant_id IS NULL OR (length(tenant_id) BETWEEN 2 AND 64 AND substr(tenant_id, 1, 1) GLOB '[a-z0-9]'
    AND tenant_id NOT GLOB '*[^a-z0-9-]*')
);
ALTER TABLE newo_sessions ADD COLUMN tenant_binding_state TEXT NOT NULL DEFAULT 'unbound'
  CHECK (tenant_binding_state IN ('bound', 'unbound', 'conflict'));
ALTER TABLE newo_sessions ADD COLUMN tenant_binding_source TEXT NOT NULL DEFAULT 'legacy_unresolved'
  CHECK (tenant_binding_source IN (
    'producer', 'legacy_envelope', 'legacy_job', 'legacy_envelope_job',
    'legacy_unresolved', 'legacy_conflict'
  ));
ALTER TABLE newo_sessions ADD COLUMN tenant_binding_ref TEXT
  CHECK (tenant_binding_ref IS NULL OR length(tenant_binding_ref) BETWEEN 1 AND 512);
ALTER TABLE newo_event_receipts ADD COLUMN tenant_id TEXT CHECK (
  tenant_id IS NULL OR (length(tenant_id) BETWEEN 2 AND 64 AND substr(tenant_id, 1, 1) GLOB '[a-z0-9]'
    AND tenant_id NOT GLOB '*[^a-z0-9-]*')
);
ALTER TABLE newo_event_receipts ADD COLUMN admission_json TEXT CHECK (
  admission_json IS NULL OR (length(admission_json) BETWEEN 2 AND 2048 AND json_valid(admission_json))
);

-- These views exist only during this migration; they retain no raw content or derived authority.
CREATE VIEW _newo0172_owned_jobs AS
SELECT session.session_id, job.tenant_id, job.roof_job_id, job.source_envelope_id
  FROM newo_sessions session
  JOIN operating_roof_jobs job ON job.roof_job_id = session.matched_roof_job_id
  JOIN operating_customers customer ON customer.customer_id = job.customer_id
    AND customer.tenant_id = job.tenant_id AND customer.customer_id = session.matched_customer_id
  JOIN operating_properties property ON property.property_id = job.property_id
    AND property.tenant_id = job.tenant_id AND property.property_key = session.matched_property_id
  JOIN operating_leads lead ON lead.lead_id = job.lead_id AND lead.tenant_id = job.tenant_id
  JOIN envelopes job_envelope ON job_envelope.envelope_id = job.source_envelope_id
    AND job_envelope.tenant_id = job.tenant_id
  JOIN envelopes customer_envelope ON customer_envelope.envelope_id = customer.source_envelope_id
    AND customer_envelope.tenant_id = job.tenant_id
  JOIN envelopes property_envelope ON property_envelope.envelope_id = property.source_envelope_id
    AND property_envelope.tenant_id = job.tenant_id
  JOIN envelopes lead_envelope ON lead_envelope.envelope_id = lead.source_envelope_id
    AND lead_envelope.tenant_id = job.tenant_id
 WHERE session.verification_status = 'verified';

CREATE VIEW _newo0172_owned_envelopes AS
SELECT session.session_id, envelope.envelope_id, envelope.tenant_id
  FROM newo_sessions session JOIN envelopes envelope
 WHERE (envelope.source = 'phone' AND json_valid(envelope.payload_json)
        AND json_extract(envelope.payload_json, '$.provider') = 'newo'
        AND json_extract(envelope.payload_json, '$.session_id') = session.session_id)
    OR EXISTS (SELECT 1 FROM _newo0172_owned_jobs job
                WHERE job.session_id = session.session_id
                  AND job.source_envelope_id = envelope.envelope_id
                  AND job.tenant_id = envelope.tenant_id);

CREATE VIEW _newo0172_candidates AS
SELECT session.session_id, envelope.tenant_id, 'envelope' AS source, 'envelope:' || envelope.envelope_id AS ref
  FROM newo_sessions session JOIN _newo0172_owned_envelopes envelope
    ON envelope.session_id = session.session_id AND envelope.envelope_id = session.lead_envelope_id
UNION
SELECT receipt.session_id, envelope.tenant_id, 'envelope', 'envelope:' || envelope.envelope_id
  FROM newo_event_receipts receipt JOIN _newo0172_owned_envelopes envelope
    ON envelope.session_id = receipt.session_id AND envelope.envelope_id = receipt.envelope_id
 WHERE receipt.status = 'accepted'
UNION
SELECT session_id, tenant_id, 'job', 'job:' || roof_job_id FROM _newo0172_owned_jobs;

CREATE VIEW _newo0172_decisions AS
SELECT session.session_id, candidates.tenant_id,
  CASE
    WHEN COALESCE(candidates.tenant_count, 0) > 1
      OR (session.lead_envelope_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM _newo0172_owned_envelopes envelope
         WHERE envelope.session_id = session.session_id AND envelope.envelope_id = session.lead_envelope_id
      ))
      OR EXISTS (SELECT 1 FROM newo_event_receipts receipt
        WHERE receipt.session_id = session.session_id AND receipt.envelope_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM _newo0172_owned_envelopes envelope
            WHERE envelope.session_id = session.session_id AND envelope.envelope_id = receipt.envelope_id))
      OR ((session.matched_roof_job_id IS NOT NULL OR session.matched_customer_id IS NOT NULL
           OR session.matched_property_id IS NOT NULL OR session.verification_status = 'verified')
          AND NOT EXISTS (SELECT 1 FROM _newo0172_owned_jobs job WHERE job.session_id = session.session_id))
      OR (candidates.tenant_count = 1 AND (
        EXISTS (SELECT 1 FROM newo_callback_records callback WHERE callback.session_id = session.session_id
                 AND callback.tenant_id <> candidates.tenant_id)
        OR EXISTS (SELECT 1 FROM newo_handoff_resolutions resolution WHERE resolution.session_id = session.session_id
                    AND resolution.tenant_id <> candidates.tenant_id)))
      THEN 'conflict'
    WHEN candidates.tenant_count = 1 THEN 'bound'
    ELSE 'unbound'
  END AS binding_state,
  CASE WHEN candidates.has_envelope = 1 AND candidates.has_job = 1 THEN 'legacy_envelope_job'
       WHEN candidates.has_job = 1 THEN 'legacy_job' ELSE 'legacy_envelope' END AS binding_source,
  candidates.ref
  FROM newo_sessions session LEFT JOIN (
    SELECT session_id, COUNT(DISTINCT tenant_id) AS tenant_count, MIN(tenant_id) AS tenant_id,
      MAX(source = 'envelope') AS has_envelope, MAX(source = 'job') AS has_job, MIN(ref) AS ref
      FROM _newo0172_candidates GROUP BY session_id
  ) candidates ON candidates.session_id = session.session_id;

UPDATE newo_sessions SET (tenant_id, tenant_binding_state, tenant_binding_source, tenant_binding_ref) = (
  SELECT CASE WHEN binding_state = 'bound' THEN tenant_id ELSE NULL END,
    binding_state,
    CASE binding_state WHEN 'bound' THEN binding_source WHEN 'conflict' THEN 'legacy_conflict'
      ELSE 'legacy_unresolved' END,
    CASE WHEN binding_state = 'bound' THEN ref ELSE NULL END
    FROM _newo0172_decisions decision WHERE decision.session_id = newo_sessions.session_id
);

-- Receipt identity is backfilled from its own original envelope. A no-envelope receipt needs
-- an original verified job and exact durable session hash/raw-key corroboration. Everything
-- else remains NULL; it is not assigned to the current deployment or a future caller.
UPDATE newo_event_receipts SET tenant_id = (
  SELECT session.tenant_id FROM newo_sessions session
   WHERE session.session_id = newo_event_receipts.session_id AND session.tenant_binding_state = 'bound'
     AND (EXISTS (SELECT 1 FROM _newo0172_owned_envelopes envelope
           WHERE envelope.session_id = session.session_id
             AND envelope.envelope_id = newo_event_receipts.envelope_id
             AND envelope.tenant_id = session.tenant_id)
       OR (newo_event_receipts.envelope_id IS NULL
           AND session.tenant_binding_source IN ('legacy_job', 'legacy_envelope_job')
           AND session.payload_hash = newo_event_receipts.payload_hash
           AND session.raw_key = newo_event_receipts.raw_key))
);
DROP VIEW _newo0172_decisions;
DROP VIEW _newo0172_candidates;
DROP VIEW _newo0172_owned_envelopes;
DROP VIEW _newo0172_owned_jobs;

CREATE UNIQUE INDEX idx_newo_sessions_id_tenant ON newo_sessions (session_id, tenant_id);
CREATE INDEX idx_newo_sessions_tenant_binding ON newo_sessions (tenant_binding_state, tenant_id, session_id);
CREATE INDEX idx_newo_receipts_tenant_session ON newo_event_receipts (tenant_id, session_id, first_seen_at);

ALTER TABLE newo_sessions ADD COLUMN last_event_id TEXT
  CHECK (last_event_id IS NULL OR length(last_event_id) BETWEEN 1 AND 128);

CREATE TABLE newo_event_admissions (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 2 AND 64 AND substr(tenant_id, 1, 1) GLOB '[a-z0-9]'
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'),
  session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 128),
  event_type TEXT NOT NULL CHECK (event_type IN ('caller_lookup', 'lead_captured', 'handoff_requested',
    'session_ended', 'session_failed', 'missed_call', 'booking_requested', 'booking_cancelled')),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  raw_key TEXT NOT NULL CHECK (length(raw_key) BETWEEN 1 AND 1024),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40 AND julianday(occurred_at) IS NOT NULL),
  envelope_id TEXT,
  reported_handoff_status TEXT CHECK (reported_handoff_status IS NULL OR reported_handoff_status IN ('requested', 'failed')),
  reported_urgency TEXT NOT NULL CHECK (reported_urgency IN ('routine', 'urgent', 'emergency')),
  event_has_contact INTEGER NOT NULL CHECK (event_has_contact IN (0, 1)),
  prior_status TEXT,
  prior_handoff_status TEXT CHECK (prior_handoff_status IS NULL OR prior_handoff_status IN ('requested', 'failed')),
  prior_urgency TEXT CHECK (prior_urgency IS NULL OR prior_urgency IN ('routine', 'urgent', 'emergency')),
  prior_has_contact INTEGER NOT NULL CHECK (prior_has_contact IN (0, 1)),
  matched_customer_id TEXT,
  matched_property_id TEXT,
  matched_roof_job_id TEXT,
  verification_status TEXT,
  effective_urgency TEXT GENERATED ALWAYS AS (
    CASE WHEN event_type = 'caller_lookup' THEN prior_urgency
      WHEN 'emergency' IN (reported_urgency, prior_urgency) THEN 'emergency'
      WHEN 'urgent' IN (reported_urgency, prior_urgency) THEN 'urgent' ELSE 'routine' END
  ) VIRTUAL,
  effective_handoff_status TEXT GENERATED ALWAYS AS (
    CASE WHEN 'failed' IN (reported_handoff_status, prior_handoff_status) THEN 'failed'
      WHEN 'requested' IN (reported_handoff_status, prior_handoff_status) OR event_type = 'handoff_requested' THEN 'requested'
      WHEN event_type IN ('session_ended', 'session_failed') AND effective_urgency = 'emergency' THEN 'failed'
      ELSE NULL END
  ) VIRTUAL,
  projected_status TEXT GENERATED ALWAYS AS (
    CASE event_type WHEN 'caller_lookup' THEN COALESCE(prior_status, 'caller_lookup')
      WHEN 'lead_captured' THEN 'active' WHEN 'handoff_requested' THEN 'handoff_requested'
      WHEN 'session_ended' THEN 'ended' WHEN 'session_failed' THEN 'failed' WHEN 'missed_call' THEN 'missed'
      WHEN 'booking_requested' THEN 'appointment_requested' WHEN 'booking_cancelled' THEN 'appointment_cancelled' END
  ) VIRTUAL,
  callback_reason TEXT GENERATED ALWAYS AS (
    CASE WHEN event_type = 'caller_lookup' THEN NULL
      WHEN reported_handoff_status = 'failed'
        OR (event_type IN ('session_ended', 'session_failed') AND effective_urgency = 'emergency'
          AND prior_handoff_status IS NOT 'requested' AND reported_handoff_status IS NOT 'requested') THEN 'handoff_failed'
      WHEN event_type = 'handoff_requested' OR reported_handoff_status = 'requested' THEN 'callback_requested'
      WHEN event_type = 'session_failed' AND (event_has_contact = 1 OR prior_has_contact = 1) THEN 'session_failed'
      ELSE NULL END
  ) VIRTUAL,
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (event_id) REFERENCES newo_event_receipts(event_id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id, tenant_id) REFERENCES newo_sessions(session_id, tenant_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (envelope_id) REFERENCES envelopes(envelope_id) ON DELETE RESTRICT
);
CREATE INDEX idx_newo_admissions_tenant_session ON newo_event_admissions (tenant_id, session_id, callback_reason, event_id);

CREATE TRIGGER newo_event_admissions_validate_insert BEFORE INSERT ON newo_event_admissions
BEGIN
  SELECT RAISE(ABORT, 'newo_event_admission_receipt_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM newo_event_receipts receipt WHERE receipt.event_id = NEW.event_id
      AND receipt.session_id = NEW.session_id AND receipt.tenant_id = NEW.tenant_id
      AND receipt.status = 'processing' AND receipt.payload_hash = NEW.payload_sha256 AND receipt.raw_key = NEW.raw_key
      AND receipt.event_type = NEW.event_type AND json_valid(receipt.admission_json)
      AND json_extract(receipt.admission_json, '$.occurred_at') = NEW.occurred_at
      AND json_extract(receipt.admission_json, '$.reported_handoff_status') IS NEW.reported_handoff_status
      AND json_extract(receipt.admission_json, '$.reported_urgency') = NEW.reported_urgency
      AND json_extract(receipt.admission_json, '$.event_has_contact') = NEW.event_has_contact
  );
  SELECT RAISE(ABORT, 'newo_event_admission_prior_invalid') WHERE
    NEW.prior_status IS NOT (SELECT status FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.prior_handoff_status IS NOT (SELECT handoff_status FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.prior_urgency IS NOT (SELECT urgency FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.prior_has_contact IS NOT COALESCE((SELECT CASE
      WHEN length(trim(COALESCE(contact_phone, ''))) > 0 OR length(trim(COALESCE(contact_email, ''))) > 0 THEN 1 ELSE 0 END
      FROM newo_sessions WHERE session_id = NEW.session_id), 0)
    OR EXISTS (SELECT 1 FROM newo_sessions session WHERE session.session_id = NEW.session_id
      AND (session.tenant_id IS NOT NEW.tenant_id OR session.tenant_binding_state <> 'bound'));
  SELECT RAISE(ABORT, 'newo_event_admission_envelope_invalid') WHERE
    NEW.envelope_id IS NOT COALESCE((SELECT lead_envelope_id FROM newo_sessions WHERE session_id = NEW.session_id), NEW.envelope_id)
    OR (NEW.envelope_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM envelopes envelope
      WHERE envelope.envelope_id = NEW.envelope_id AND envelope.tenant_id = NEW.tenant_id
        AND ((envelope.source = 'phone' AND json_valid(envelope.payload_json)
              AND json_extract(envelope.payload_json, '$.provider') = 'newo'
              AND json_extract(envelope.payload_json, '$.session_id') = NEW.session_id)
          OR EXISTS (SELECT 1 FROM operating_roof_jobs job WHERE job.roof_job_id = NEW.matched_roof_job_id
            AND job.tenant_id = NEW.tenant_id AND job.source_envelope_id = envelope.envelope_id))));
  SELECT RAISE(ABORT, 'newo_event_admission_job_invalid') WHERE NEW.event_type <> 'caller_lookup' AND (
    NEW.matched_customer_id IS NOT (SELECT matched_customer_id FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.matched_property_id IS NOT (SELECT matched_property_id FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.matched_roof_job_id IS NOT (SELECT matched_roof_job_id FROM newo_sessions WHERE session_id = NEW.session_id)
    OR NEW.verification_status IS NOT (SELECT verification_status FROM newo_sessions WHERE session_id = NEW.session_id)
  );
  SELECT RAISE(ABORT, 'newo_event_admission_job_invalid') WHERE
    (NEW.matched_customer_id IS NOT NULL OR NEW.matched_property_id IS NOT NULL
      OR NEW.matched_roof_job_id IS NOT NULL OR NEW.verification_status = 'verified')
    AND NOT EXISTS (SELECT 1 FROM operating_roof_jobs job
      JOIN operating_customers customer ON customer.customer_id = job.customer_id AND customer.tenant_id = job.tenant_id
      JOIN operating_properties property ON property.property_id = job.property_id AND property.tenant_id = job.tenant_id
      JOIN operating_leads lead ON lead.lead_id = job.lead_id AND lead.tenant_id = job.tenant_id
      JOIN envelopes job_origin ON job_origin.envelope_id = job.source_envelope_id AND job_origin.tenant_id = job.tenant_id
      JOIN envelopes customer_origin ON customer_origin.envelope_id = customer.source_envelope_id AND customer_origin.tenant_id = job.tenant_id
      JOIN envelopes property_origin ON property_origin.envelope_id = property.source_envelope_id AND property_origin.tenant_id = job.tenant_id
      JOIN envelopes lead_origin ON lead_origin.envelope_id = lead.source_envelope_id AND lead_origin.tenant_id = job.tenant_id
      WHERE job.roof_job_id = NEW.matched_roof_job_id AND job.tenant_id = NEW.tenant_id
        AND customer.customer_id = NEW.matched_customer_id AND property.property_key = NEW.matched_property_id
        AND NEW.verification_status = 'verified');
  SELECT RAISE(ABORT, 'newo_event_admission_clock_invalid')
    WHERE NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
CREATE TRIGGER newo_event_admissions_append_only_update BEFORE UPDATE ON newo_event_admissions
BEGIN SELECT RAISE(ABORT, 'newo_event_admission_append_only'); END;
CREATE TRIGGER newo_event_admissions_append_only_delete BEFORE DELETE ON newo_event_admissions
BEGIN SELECT RAISE(ABORT, 'newo_event_admission_append_only'); END;
CREATE TRIGGER newo_event_admissions_no_insert_replace BEFORE INSERT ON newo_event_admissions
BEGIN SELECT RAISE(ABORT, 'newo_event_admission_append_only')
  WHERE EXISTS (SELECT 1 FROM newo_event_admissions WHERE event_id = NEW.event_id); END;

CREATE TRIGGER newo_sessions_validate_insert BEFORE INSERT ON newo_sessions
BEGIN
  SELECT RAISE(ABORT, 'newo_session_tenant_required') WHERE NEW.tenant_id IS NULL
    OR NEW.tenant_binding_state <> 'bound' OR NEW.tenant_binding_source <> 'producer'
    OR NEW.tenant_binding_ref IS NOT NEW.last_event_id;
  SELECT RAISE(ABORT, 'newo_session_event_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM newo_event_admissions admission WHERE admission.event_id = NEW.last_event_id
      AND admission.session_id = NEW.session_id AND admission.tenant_id = NEW.tenant_id
      AND admission.payload_sha256 = NEW.payload_hash AND admission.raw_key = NEW.raw_key
      AND admission.occurred_at = NEW.updated_at AND admission.projected_status = NEW.status
      AND admission.effective_urgency IS NEW.urgency AND admission.effective_handoff_status IS NEW.handoff_status
      AND admission.envelope_id IS NEW.lead_envelope_id
      AND admission.matched_customer_id IS NEW.matched_customer_id
      AND admission.matched_property_id IS NEW.matched_property_id
      AND admission.matched_roof_job_id IS NEW.matched_roof_job_id
      AND admission.verification_status IS NEW.verification_status
  );
END;
CREATE TRIGGER newo_sessions_validate_update BEFORE UPDATE ON newo_sessions
BEGIN
  SELECT RAISE(ABORT, 'newo_session_binding_immutable') WHERE NEW.session_id IS NOT OLD.session_id
    OR NEW.tenant_id IS NOT OLD.tenant_id OR NEW.tenant_binding_state IS NOT OLD.tenant_binding_state
    OR NEW.tenant_binding_source IS NOT OLD.tenant_binding_source OR NEW.tenant_binding_ref IS NOT OLD.tenant_binding_ref
    OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'newo_session_event_invalid') WHERE
    (NEW.status IS NOT OLD.status OR NEW.handoff_status IS NOT OLD.handoff_status OR NEW.urgency IS NOT OLD.urgency
     OR NEW.updated_at IS NOT OLD.updated_at OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.raw_key IS NOT OLD.raw_key
     OR NEW.structured_json IS NOT OLD.structured_json OR NEW.last_event_id IS NOT OLD.last_event_id
     OR NEW.lead_envelope_id IS NOT OLD.lead_envelope_id OR NEW.matched_customer_id IS NOT OLD.matched_customer_id
     OR NEW.matched_property_id IS NOT OLD.matched_property_id OR NEW.matched_roof_job_id IS NOT OLD.matched_roof_job_id
     OR NEW.verification_status IS NOT OLD.verification_status)
    AND NOT EXISTS (SELECT 1 FROM newo_event_admissions admission
      WHERE admission.event_id = NEW.last_event_id AND admission.session_id = NEW.session_id
        AND admission.tenant_id = NEW.tenant_id AND NEW.tenant_binding_state = 'bound'
        AND admission.payload_sha256 = NEW.payload_hash AND admission.raw_key = NEW.raw_key
        AND admission.occurred_at = NEW.updated_at AND NEW.updated_at >= OLD.updated_at
        AND admission.projected_status = NEW.status AND admission.effective_urgency IS NEW.urgency
        AND admission.effective_handoff_status IS NEW.handoff_status AND admission.envelope_id IS NEW.lead_envelope_id
        AND admission.matched_customer_id IS NEW.matched_customer_id
        AND admission.matched_property_id IS NEW.matched_property_id
        AND admission.matched_roof_job_id IS NEW.matched_roof_job_id
        AND admission.verification_status IS NEW.verification_status);
END;
CREATE TRIGGER newo_sessions_append_only_delete BEFORE DELETE ON newo_sessions
BEGIN SELECT RAISE(ABORT, 'newo_session_binding_immutable'); END;
CREATE TRIGGER newo_sessions_no_insert_replace BEFORE INSERT ON newo_sessions
BEGIN SELECT RAISE(ABORT, 'newo_session_binding_immutable')
  WHERE EXISTS (SELECT 1 FROM newo_sessions WHERE session_id = NEW.session_id); END;

CREATE TRIGGER newo_receipts_validate_insert BEFORE INSERT ON newo_event_receipts
BEGIN
  SELECT RAISE(ABORT, 'newo_receipt_tenant_required') WHERE NEW.tenant_id IS NULL
    OR EXISTS (SELECT 1 FROM newo_sessions session WHERE session.session_id = NEW.session_id
      AND (session.tenant_binding_state <> 'bound' OR session.tenant_id IS NOT NEW.tenant_id));
  SELECT RAISE(ABORT, 'newo_receipt_input_invalid') WHERE NEW.status <> 'processing'
    OR NEW.attempts <> 1 OR NEW.response_json <> '{}' OR NEW.envelope_id IS NOT NULL
    OR NEW.completed_at IS NOT NULL OR NEW.last_error IS NOT NULL
    OR length(NEW.payload_hash) <> 64 OR NEW.payload_hash GLOB '*[^0-9a-f]*'
    OR NEW.admission_json IS NULL OR NOT json_valid(NEW.admission_json)
    OR json_type(NEW.admission_json) <> 'object'
    OR json_extract(NEW.admission_json, '$.schema') IS NOT 'newo.admission.v1'
    OR json_extract(NEW.admission_json, '$.event_id') IS NOT NEW.event_id
    OR json_extract(NEW.admission_json, '$.session_id') IS NOT NEW.session_id
    OR json_extract(NEW.admission_json, '$.event_type') IS NOT NEW.event_type
    OR json_extract(NEW.admission_json, '$.event_type') NOT IN ('caller_lookup', 'lead_captured', 'handoff_requested',
      'session_ended', 'session_failed', 'missed_call', 'booking_requested', 'booking_cancelled')
    OR json_type(NEW.admission_json, '$.occurred_at') IS NOT 'text'
    OR julianday(json_extract(NEW.admission_json, '$.occurred_at')) IS NULL
    OR json_type(NEW.admission_json, '$.reported_handoff_status') IS NULL
    OR json_type(NEW.admission_json, '$.reported_handoff_status') NOT IN ('text', 'null')
    OR (json_extract(NEW.admission_json, '$.reported_handoff_status') IS NOT NULL
        AND json_extract(NEW.admission_json, '$.reported_handoff_status') NOT IN ('requested', 'failed'))
    OR json_type(NEW.admission_json, '$.reported_urgency') IS NOT 'text'
    OR json_extract(NEW.admission_json, '$.reported_urgency') NOT IN ('routine', 'urgent', 'emergency')
    OR json_type(NEW.admission_json, '$.event_has_contact') IS NOT 'integer'
    OR json_extract(NEW.admission_json, '$.event_has_contact') NOT IN (0, 1)
    OR (SELECT COUNT(*) FROM json_each(NEW.admission_json)) <> 8
    OR (SELECT COUNT(DISTINCT key) FROM json_each(NEW.admission_json)) <> 8
    OR EXISTS (SELECT 1 FROM json_each(NEW.admission_json) WHERE key NOT IN (
      'schema', 'event_id', 'session_id', 'event_type', 'occurred_at',
      'reported_handoff_status', 'reported_urgency', 'event_has_contact'))
    OR (NEW.event_type = 'caller_lookup' AND (json_extract(NEW.admission_json, '$.reported_handoff_status') IS NOT NULL
      OR json_extract(NEW.admission_json, '$.event_has_contact') <> 1));
END;
CREATE TRIGGER newo_receipts_validate_update BEFORE UPDATE ON newo_event_receipts
BEGIN
  SELECT RAISE(ABORT, 'newo_receipt_identity_immutable') WHERE NEW.event_id IS NOT OLD.event_id
    OR NEW.session_id IS NOT OLD.session_id OR NEW.tenant_id IS NOT OLD.tenant_id
    OR NEW.event_type IS NOT OLD.event_type OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.raw_key IS NOT OLD.raw_key
    OR NEW.admission_json IS NOT OLD.admission_json OR NEW.first_seen_at IS NOT OLD.first_seen_at;
  SELECT RAISE(ABORT, 'newo_receipt_transition_invalid') WHERE
    (OLD.status IN ('accepted', 'dead') AND (NEW.status <> OLD.status OR NEW.attempts <> OLD.attempts
      OR NEW.response_json IS NOT OLD.response_json OR NEW.envelope_id IS NOT OLD.envelope_id
      OR NEW.completed_at IS NOT OLD.completed_at))
    OR (NEW.status <> OLD.status AND NOT (
      (OLD.status = 'processing' AND NEW.status IN ('accepted', 'failed') AND NEW.attempts = OLD.attempts)
      OR (OLD.status = 'failed' AND NEW.status = 'processing' AND NEW.attempts = OLD.attempts + 1
        AND OLD.admission_json IS NOT NULL AND NEW.completed_at IS NULL)))
    OR (NEW.status = OLD.status AND NEW.attempts <> OLD.attempts);
  SELECT RAISE(ABORT, 'newo_receipt_acceptance_invalid') WHERE NEW.status = 'accepted' AND OLD.status <> 'accepted'
    AND NOT EXISTS (SELECT 1 FROM newo_event_admissions admission WHERE admission.event_id = NEW.event_id
      AND admission.tenant_id = NEW.tenant_id AND admission.session_id = NEW.session_id
      AND admission.payload_sha256 = NEW.payload_hash
      AND ((NEW.event_type = 'caller_lookup' AND NEW.envelope_id IS NULL)
        OR (NEW.event_type <> 'caller_lookup' AND NEW.envelope_id IS admission.envelope_id)));
END;
CREATE TRIGGER newo_receipts_append_only_delete BEFORE DELETE ON newo_event_receipts
BEGIN SELECT RAISE(ABORT, 'newo_receipt_identity_immutable'); END;
CREATE TRIGGER newo_receipts_no_insert_replace BEFORE INSERT ON newo_event_receipts
BEGIN SELECT RAISE(ABORT, 'newo_receipt_identity_immutable')
  WHERE EXISTS (SELECT 1 FROM newo_event_receipts WHERE event_id = NEW.event_id); END;

-- Recreate each child insert group in its original per-table order. The duplicate guard stays
-- last-created/first-run. Historical rows are preserved; only new child writes use this guard.
DROP TRIGGER newo_callback_records_validate_insert;
DROP TRIGGER newo_callback_records_append_only_update;
DROP TRIGGER newo_callback_records_append_only_delete;
DROP TRIGGER newo_callback_records_no_insert_replace;
CREATE TRIGGER newo_callback_records_validate_insert BEFORE INSERT ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_clock_invalid')
    WHERE NEW.recorded_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
  SELECT RAISE(ABORT, 'newo_callback_record_event_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM newo_event_admissions admission JOIN newo_sessions session
      ON session.session_id = admission.session_id AND session.tenant_id = admission.tenant_id
     WHERE admission.event_id = NEW.event_id AND admission.session_id = NEW.session_id
       AND admission.tenant_id = NEW.tenant_id AND session.tenant_binding_state = 'bound'
       AND admission.callback_reason IS NEW.reason AND admission.callback_reason IS NOT NULL
       AND COALESCE(admission.effective_urgency, 'routine') = NEW.urgency
  );
END;

CREATE TRIGGER newo_callback_records_append_only_update
BEFORE UPDATE ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only');
END;

CREATE TRIGGER newo_callback_records_append_only_delete
BEFORE DELETE ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only');
END;

CREATE TRIGGER newo_callback_records_no_insert_replace
BEFORE INSERT ON newo_callback_records
BEGIN
  SELECT RAISE(ABORT, 'newo_callback_record_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM newo_callback_records existing
     WHERE existing.callback_id = NEW.callback_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.session_id = NEW.session_id)
  );
END;

DROP TRIGGER newo_handoff_resolutions_no_insert_replace;
DROP TRIGGER newo_handoff_resolutions_validate_insert;
CREATE TRIGGER newo_handoff_resolutions_validate_insert BEFORE INSERT ON newo_handoff_resolutions
BEGIN
  SELECT RAISE(ABORT, 'newo_handoff_resolution_tenant_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM newo_sessions session WHERE session.session_id = NEW.session_id
      AND session.tenant_id = NEW.tenant_id AND session.tenant_binding_state = 'bound');
  SELECT RAISE(ABORT, 'newo_handoff_resolution_not_open') WHERE NOT EXISTS (
    SELECT 1 FROM newo_callback_records callback WHERE callback.session_id = NEW.session_id AND callback.tenant_id = NEW.tenant_id
  ) AND NOT EXISTS (SELECT 1 FROM newo_event_admissions admission WHERE admission.session_id = NEW.session_id
    AND admission.tenant_id = NEW.tenant_id AND admission.callback_reason IS NOT NULL);
  SELECT RAISE(ABORT, 'newo_handoff_resolution_actor_invalid') WHERE NOT EXISTS (
    SELECT 1 FROM app_users actor WHERE actor.tenant_id = NEW.tenant_id AND actor.user_id = NEW.resolved_by
      AND actor.active = 1 AND actor.access_role = NEW.resolved_by_role);
  SELECT RAISE(ABORT, 'newo_handoff_resolution_note_required') WHERE NEW.note IS NULL;
  SELECT RAISE(ABORT, 'newo_handoff_resolution_clock_invalid')
    WHERE NEW.resolved_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER newo_handoff_resolutions_no_insert_replace
BEFORE INSERT ON newo_handoff_resolutions
BEGIN
  SELECT RAISE(ABORT, 'newo_handoff_resolution_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM newo_handoff_resolutions existing
     WHERE existing.resolution_id = NEW.resolution_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
  );
  SELECT RAISE(ABORT, 'newo_handoff_already_resolved')
  WHERE EXISTS (
    SELECT 1
      FROM newo_handoff_resolutions existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.session_id = NEW.session_id
  );
END;
