-- Owner-verified, bounded agent subject erasure and independent restore commitments.
-- Signals keep the 90-day exception from 0207. Only a marker-confirmed exact target admits
-- the same erasure earlier. lead_fact.propose live/shadow arguments admit one exact four-field
-- nulling; all other columns and original hashes stay pinned. No operating-plane object changes.
-- R2 PRIVACY_LEDGER durability and current-owner authority are enforced by the Worker flow.
-- Database claims hold runtime writes before the independent marker/text work can progress.

CREATE TABLE IF NOT EXISTS agent_subject_erasures (
  erasure_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  customer_version INTEGER NOT NULL CHECK (customer_version >= 1),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json) AND json_type(scope_json) = 'object'),
  signal_seq_ceiling INTEGER NOT NULL CHECK (signal_seq_ceiling >= 0),
  requested_at TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  verification_method TEXT NOT NULL CHECK (verification_method IN ('on_file_phone', 'on_file_email')),
  verification_ref_sha256 TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (erasure_id, tenant_id),
  CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(verification_ref_sha256) = 64 AND verification_ref_sha256 NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE IF NOT EXISTS agent_signal_erasures (
  tenant_id TEXT NOT NULL,
  signal_id TEXT NOT NULL REFERENCES agent_signals (signal_id),
  erasure_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'owner_request', 'handoff')),
  subject_aggregate TEXT,
  subject_id TEXT,
  received_at TEXT NOT NULL,
  signal_seq_at_decision INTEGER NOT NULL CHECK (signal_seq_at_decision > 0),
  marker_sha256 TEXT,
  marker_confirmed_at TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, signal_id),
  FOREIGN KEY (erasure_id, tenant_id) REFERENCES agent_subject_erasures (erasure_id, tenant_id),
  CHECK ((marker_sha256 IS NULL) = (marker_confirmed_at IS NULL)),
  CHECK (marker_sha256 IS NULL OR (length(marker_sha256) = 64 AND marker_sha256 NOT GLOB '*[^0-9a-f]*'))
);

CREATE INDEX IF NOT EXISTS idx_agent_subject_erasures_tenant_customer ON agent_subject_erasures (tenant_id, customer_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_agent_signal_erasures_request ON agent_signal_erasures (tenant_id, erasure_id, signal_seq_at_decision);
CREATE INDEX IF NOT EXISTS idx_agent_signals_erasure_subject ON agent_signals (tenant_id, subject_aggregate, subject_id, signal_seq);
CREATE INDEX IF NOT EXISTS idx_agent_signals_erasure_sender ON agent_signals (tenant_id, json_extract(content_json, '$.sender.customer_id'), signal_seq) WHERE kind = 'event';
CREATE INDEX IF NOT EXISTS idx_agent_runs_erasure_signal ON agent_runs (tenant_id, signal_id, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_shadow_steps_erasure_run ON agent_shadow_steps (tenant_id, run_id, action_id);

CREATE TRIGGER IF NOT EXISTS agent_subject_erasures_validate_insert BEFORE INSERT ON agent_subject_erasures
WHEN NOT (
  NEW.erasure_id GLOB 'era_*' AND length(NEW.erasure_id) = 68 AND substr(NEW.erasure_id, 5) NOT GLOB '*[^0-9a-f]*'
  AND json_extract(NEW.scope_json, '$.customer_id') IS NEW.customer_id
  AND json_type(NEW.scope_json, '$.leads') IS 'array' AND json_type(NEW.scope_json, '$.jobs') IS 'array'
  AND json_type(NEW.scope_json, '$.signals') IS 'array' AND json_array_length(NEW.scope_json, '$.signals') <= 100
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.scope_json, '$.signals') f WHERE f.type IS NOT 'object'
    OR json_type(f.value, '$.signal_id') IS NOT 'text' OR length(json_extract(f.value, '$.signal_id')) NOT BETWEEN 1 AND 200
    OR json_extract(f.value, '$.signal_id') GLOB '*[^A-Za-z0-9._:-]*'
    OR json_type(f.value, '$.content_sha256') IS NOT 'text' OR length(json_extract(f.value, '$.content_sha256')) <> 64
    OR json_extract(f.value, '$.content_sha256') GLOB '*[^0-9a-f]*')
  AND json_array_length(NEW.scope_json, '$.leads') + json_array_length(NEW.scope_json, '$.jobs') + 1 <= 64
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.scope_json, '$.leads') WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 200 OR value GLOB '*[^A-Za-z0-9._:-]*')
  AND NOT EXISTS (SELECT 1 FROM json_each(NEW.scope_json, '$.jobs') WHERE type <> 'text' OR length(value) NOT BETWEEN 1 AND 200 OR value GLOB '*[^A-Za-z0-9._:-]*')
)
BEGIN SELECT RAISE(ABORT, 'agent_erasure_scope_invalid'); END;
CREATE TRIGGER IF NOT EXISTS prevent_agent_subject_erasure_update BEFORE UPDATE ON agent_subject_erasures
BEGIN SELECT RAISE(ABORT, 'agent_subject_erasures_append_only'); END;
CREATE TRIGGER IF NOT EXISTS prevent_agent_subject_erasure_delete BEFORE DELETE ON agent_subject_erasures
BEGIN SELECT RAISE(ABORT, 'agent_subject_erasures_append_only'); END;
CREATE TRIGGER IF NOT EXISTS agent_subject_erasures_no_insert_replace BEFORE INSERT ON agent_subject_erasures
WHEN EXISTS (SELECT 1 FROM agent_subject_erasures d WHERE d.erasure_id = NEW.erasure_id OR (d.tenant_id = NEW.tenant_id AND d.idempotency_key = NEW.idempotency_key))
BEGIN SELECT RAISE(ABORT, 'agent_subject_erasures_append_only'); END;

CREATE TRIGGER IF NOT EXISTS agent_signal_erasures_validate_insert BEFORE INSERT ON agent_signal_erasures
WHEN NEW.marker_sha256 IS NOT NULL OR NEW.marker_confirmed_at IS NOT NULL OR NOT EXISTS (
  SELECT 1 FROM agent_signals s JOIN agent_subject_erasures d ON d.erasure_id = NEW.erasure_id AND d.tenant_id = NEW.tenant_id
  WHERE s.tenant_id = NEW.tenant_id AND s.signal_id = NEW.signal_id AND s.content_sha256 IS NEW.content_sha256
    AND s.kind IS NEW.kind AND s.subject_aggregate IS NEW.subject_aggregate AND s.subject_id IS NEW.subject_id
    AND s.received_at IS NEW.received_at AND s.signal_seq IS NEW.signal_seq_at_decision AND s.signal_seq <= d.signal_seq_ceiling
    AND EXISTS (SELECT 1 FROM json_each(d.scope_json, '$.signals') f WHERE json_extract(f.value, '$.signal_id') IS NEW.signal_id
      AND json_extract(f.value, '$.content_sha256') IS NEW.content_sha256)
    AND (s.subject_aggregate IS 'customer' AND s.subject_id IS d.customer_id
      OR s.subject_aggregate IS 'lead' AND s.subject_id IN (SELECT value FROM json_each(d.scope_json, '$.leads'))
      OR s.subject_aggregate IS 'job' AND s.subject_id IN (SELECT value FROM json_each(d.scope_json, '$.jobs'))
      OR s.kind IS 'event' AND json_extract(s.content_json, '$.sender.customer_id') IS d.customer_id
        AND json_type(s.content_json, '$.sender.conflict') IS 'false'
        AND json_extract(s.content_json, '$.sender.matched_on') IN ('phone', 'email', 'email_and_phone'))
)
BEGIN SELECT RAISE(ABORT, 'agent_erasure_target_invalid'); END;
CREATE TRIGGER IF NOT EXISTS agent_signal_erasures_confirm_guard BEFORE UPDATE ON agent_signal_erasures
WHEN NOT (OLD.marker_sha256 IS NULL AND OLD.marker_confirmed_at IS NULL
    AND NEW.marker_sha256 IS NOT NULL AND NEW.marker_confirmed_at IS NOT NULL
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.signal_id IS OLD.signal_id
    AND NEW.erasure_id IS OLD.erasure_id
    AND NEW.content_sha256 IS OLD.content_sha256
    AND NEW.kind IS OLD.kind
    AND NEW.subject_aggregate IS OLD.subject_aggregate
    AND NEW.subject_id IS OLD.subject_id
    AND NEW.received_at IS OLD.received_at
    AND NEW.signal_seq_at_decision IS OLD.signal_seq_at_decision
    AND NEW.recorded_at IS OLD.recorded_at
  )
BEGIN SELECT RAISE(ABORT, 'agent_signal_erasures_append_only'); END;
CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_erasure_delete BEFORE DELETE ON agent_signal_erasures
BEGIN SELECT RAISE(ABORT, 'agent_signal_erasures_append_only'); END;
CREATE TRIGGER IF NOT EXISTS agent_signal_erasures_no_insert_replace BEFORE INSERT ON agent_signal_erasures
WHEN EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = NEW.tenant_id AND e.signal_id = NEW.signal_id)
BEGIN SELECT RAISE(ABORT, 'agent_signal_erasures_append_only'); END;

DROP TRIGGER IF EXISTS prevent_agent_signal_update;
CREATE TRIGGER IF NOT EXISTS prevent_agent_signal_update
BEFORE UPDATE ON agent_signals
WHEN NOT (
    OLD.kind IN ('event', 'owner_request', 'handoff')
    AND json_extract(OLD.content_json, '$.redacted') IS NULL
    AND (OLD.received_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-90 days')
      OR EXISTS (SELECT 1 FROM agent_signal_erasures e
      WHERE e.tenant_id = OLD.tenant_id AND e.signal_id = OLD.signal_id
        AND e.content_sha256 IS OLD.content_sha256 AND e.kind IS OLD.kind
        AND e.subject_aggregate IS OLD.subject_aggregate AND e.subject_id IS OLD.subject_id
        AND e.received_at IS OLD.received_at AND e.signal_seq_at_decision IS OLD.signal_seq
        AND e.marker_sha256 IS NOT NULL AND e.marker_confirmed_at IS NOT NULL))
    AND NEW.content_json IS CASE OLD.kind
      WHEN 'event' THEN json_set(json_remove(OLD.content_json, '$.excerpt', '$.form_fields', '$.service'), '$.redacted', json('true'))
      WHEN 'owner_request' THEN json_set(json_remove(OLD.content_json, '$.question'), '$.redacted', json('true'))
      WHEN 'handoff' THEN json_set(json_remove(OLD.content_json, '$.reason'), '$.redacted', json('true'))
    END
    AND NEW.signal_seq IS OLD.signal_seq
    AND NEW.signal_id IS OLD.signal_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.kind IS OLD.kind
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.watch_id IS OLD.watch_id
    AND NEW.source IS OLD.source
    AND NEW.subject_aggregate IS OLD.subject_aggregate
    AND NEW.subject_id IS OLD.subject_id
    AND NEW.content_sha256 IS OLD.content_sha256
    AND NEW.dedupe_key IS OLD.dedupe_key
    AND NEW.parent_run_id IS OLD.parent_run_id
    AND NEW.handoff_depth IS OLD.handoff_depth
    AND NEW.received_at IS OLD.received_at
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_signals_append_only');
END;

DROP TRIGGER IF EXISTS prevent_agent_step_proposal_update;
CREATE TRIGGER prevent_agent_step_proposal_update
BEFORE UPDATE OF step_id, tenant_id, run_id, step_seq, step_key, specialist_id, action_id, autonomy,
  args_json, args_sha256, sources_json, created_at ON agent_run_steps
WHEN NOT (
    OLD.specialist_id IS 'lead_concierge' AND OLD.action_id IS 'lead_fact.propose'
    AND json_type(OLD.args_json) IS 'object' AND json_type(OLD.args_json, '$.fields') IS 'object'
    AND json_type(OLD.args_json, '$.redacted') IS NULL
    AND NEW.args_json IS json_set(OLD.args_json, '$.fields.service', NULL, '$.fields.scope', NULL,
      '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))
    AND EXISTS (SELECT 1 FROM agent_runs r JOIN agent_signals s ON s.signal_id = r.signal_id AND s.tenant_id = r.tenant_id
      JOIN agent_signal_erasures e ON e.signal_id = s.signal_id AND e.tenant_id = s.tenant_id
      WHERE r.run_id = OLD.run_id AND r.tenant_id = OLD.tenant_id AND r.specialist_id IS OLD.specialist_id
        AND s.kind IS 'event' AND s.source IN ('web_form', 'instant_estimate', 'phone', 'newo_call', 'walk_in', 'office', 'gbp', 'ad', 'referral')
        AND s.subject_aggregate IS 'lead' AND s.subject_id IS json_extract(OLD.args_json, '$.lead_id')
        AND e.content_sha256 IS s.content_sha256 AND e.kind IS s.kind
        AND e.subject_aggregate IS s.subject_aggregate AND e.subject_id IS s.subject_id
        AND e.received_at IS s.received_at AND e.signal_seq_at_decision IS s.signal_seq
        AND e.marker_sha256 IS NOT NULL AND e.marker_confirmed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(OLD.sources_json) c
          WHERE json_extract(c.value, '$.fact_id') IS 'signal/' || s.signal_id
            AND json_extract(c.value, '$.version') IS 1
            AND json_extract(c.value, '$.hash') IS 'sha256:' || s.content_sha256))
    AND NEW.step_id IS OLD.step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.step_seq IS OLD.step_seq
    AND NEW.step_key IS OLD.step_key
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.autonomy IS OLD.autonomy
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.policy_json IS OLD.policy_json
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.readback_json IS OLD.readback_json
    AND NEW.outcome IS OLD.outcome
    AND NEW.reason_code IS OLD.reason_code
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND NEW.needs_ask IS OLD.needs_ask
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.do_it_myself_json IS OLD.do_it_myself_json
    AND NEW.created_at IS OLD.created_at
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.version IS OLD.version
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_step_proposal_immutable');
END;

DROP TRIGGER IF EXISTS prevent_decided_agent_step_update;
CREATE TRIGGER prevent_decided_agent_step_update
BEFORE UPDATE ON agent_run_steps
WHEN OLD.outcome IS NOT NULL AND OLD.outcome <> 'unknown'
  AND NOT (
    OLD.outcome IS 'succeeded'
    AND OLD.action_id IN ('delegation.propose_change', 'access.prepare_change')
    AND OLD.needs_ask IS 'apply_in_own_screen'
    AND NEW.needs_ask IS NULL
    AND COALESCE(NEW.reason_code IN ('applied_by_person', 'superseded'), 0)
    AND json_extract(NEW.policy_json, '$.reason_codes') IS json_array(NEW.reason_code)
    AND json_remove(NEW.policy_json, '$.reason_codes') IS json_remove(OLD.policy_json, '$.reason_codes')
    AND json_remove(NEW.do_it_myself_json, '$.context.applied') IS json_remove(OLD.do_it_myself_json, '$.context.applied')
    AND NEW.version IS OLD.version + 1
    AND NEW.decided_at IS strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    AND NEW.outcome IS OLD.outcome
    AND NEW.step_id IS OLD.step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.step_seq IS OLD.step_seq
    AND NEW.step_key IS OLD.step_key
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.autonomy IS OLD.autonomy
    AND NEW.args_json IS OLD.args_json
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.created_at IS OLD.created_at
  ) AND NOT (
    OLD.specialist_id IS 'lead_concierge' AND OLD.action_id IS 'lead_fact.propose'
    AND json_type(OLD.args_json) IS 'object' AND json_type(OLD.args_json, '$.fields') IS 'object'
    AND json_type(OLD.args_json, '$.redacted') IS NULL
    AND NEW.args_json IS json_set(OLD.args_json, '$.fields.service', NULL, '$.fields.scope', NULL,
      '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))
    AND EXISTS (SELECT 1 FROM agent_runs r JOIN agent_signals s ON s.signal_id = r.signal_id AND s.tenant_id = r.tenant_id
      JOIN agent_signal_erasures e ON e.signal_id = s.signal_id AND e.tenant_id = s.tenant_id
      WHERE r.run_id = OLD.run_id AND r.tenant_id = OLD.tenant_id AND r.specialist_id IS OLD.specialist_id
        AND s.kind IS 'event' AND s.source IN ('web_form', 'instant_estimate', 'phone', 'newo_call', 'walk_in', 'office', 'gbp', 'ad', 'referral')
        AND s.subject_aggregate IS 'lead' AND s.subject_id IS json_extract(OLD.args_json, '$.lead_id')
        AND e.content_sha256 IS s.content_sha256 AND e.kind IS s.kind
        AND e.subject_aggregate IS s.subject_aggregate AND e.subject_id IS s.subject_id
        AND e.received_at IS s.received_at AND e.signal_seq_at_decision IS s.signal_seq
        AND e.marker_sha256 IS NOT NULL AND e.marker_confirmed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(OLD.sources_json) c
          WHERE json_extract(c.value, '$.fact_id') IS 'signal/' || s.signal_id
            AND json_extract(c.value, '$.version') IS 1
            AND json_extract(c.value, '$.hash') IS 'sha256:' || s.content_sha256))
    AND NEW.step_id IS OLD.step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.step_seq IS OLD.step_seq
    AND NEW.step_key IS OLD.step_key
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.autonomy IS OLD.autonomy
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.policy_json IS OLD.policy_json
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.readback_json IS OLD.readback_json
    AND NEW.outcome IS OLD.outcome
    AND NEW.reason_code IS OLD.reason_code
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND NEW.needs_ask IS OLD.needs_ask
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.do_it_myself_json IS OLD.do_it_myself_json
    AND NEW.created_at IS OLD.created_at
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.version IS OLD.version
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_step_decided');
END;

DROP TRIGGER IF EXISTS prevent_agent_shadow_step_update;
CREATE TRIGGER prevent_agent_shadow_step_update
BEFORE UPDATE ON agent_shadow_steps
WHEN NOT (
    OLD.specialist_id IS 'lead_concierge' AND OLD.action_id IS 'lead_fact.propose'
    AND json_type(OLD.args_json) IS 'object' AND json_type(OLD.args_json, '$.fields') IS 'object'
    AND json_type(OLD.args_json, '$.redacted') IS NULL
    AND NEW.args_json IS json_set(OLD.args_json, '$.fields.service', NULL, '$.fields.scope', NULL,
      '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))
    AND EXISTS (SELECT 1 FROM agent_runs r JOIN agent_signals s ON s.signal_id = r.signal_id AND s.tenant_id = r.tenant_id
      JOIN agent_signal_erasures e ON e.signal_id = s.signal_id AND e.tenant_id = s.tenant_id
      WHERE r.run_id = OLD.run_id AND r.tenant_id = OLD.tenant_id AND r.specialist_id IS OLD.specialist_id
        AND s.kind IS 'event' AND s.source IN ('web_form', 'instant_estimate', 'phone', 'newo_call', 'walk_in', 'office', 'gbp', 'ad', 'referral')
        AND s.subject_aggregate IS 'lead' AND s.subject_id IS json_extract(OLD.args_json, '$.lead_id')
        AND e.content_sha256 IS s.content_sha256 AND e.kind IS s.kind
        AND e.subject_aggregate IS s.subject_aggregate AND e.subject_id IS s.subject_id
        AND e.received_at IS s.received_at AND e.signal_seq_at_decision IS s.signal_seq
        AND e.marker_sha256 IS NOT NULL AND e.marker_confirmed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(OLD.sources_json) c
          WHERE json_extract(c.value, '$.fact_id') IS 'signal/' || s.signal_id
            AND json_extract(c.value, '$.version') IS 1
            AND json_extract(c.value, '$.hash') IS 'sha256:' || s.content_sha256))
    AND NEW.shadow_step_id IS OLD.shadow_step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.step_key IS OLD.step_key
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.policy_json IS OLD.policy_json
    AND NEW.subject_aggregate IS OLD.subject_aggregate
    AND NEW.subject_id IS OLD.subject_id
    AND NEW.proposed_at IS OLD.proposed_at
  )
BEGIN
  SELECT RAISE(ABORT, 'agent_shadow_steps_append_only');
END;

CREATE TRIGGER IF NOT EXISTS agent_runs_erasure_insert_guard BEFORE INSERT ON agent_runs WHEN (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = NEW.tenant_id AND e.signal_id = NEW.signal_id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = NEW.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(NEW.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = NEW.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/'))
BEGIN SELECT RAISE(ABORT, 'agent_source_erased'); END;
CREATE TRIGGER IF NOT EXISTS agent_runs_erasure_update_guard BEFORE UPDATE ON agent_runs WHEN (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = OLD.tenant_id AND e.signal_id = OLD.signal_id)
  OR EXISTS (SELECT 1 FROM json_each(OLD.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = OLD.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(OLD.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = OLD.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')) OR (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = NEW.tenant_id AND e.signal_id = NEW.signal_id)
  OR EXISTS (SELECT 1 FROM json_each(NEW.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = NEW.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(NEW.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = NEW.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/'))
BEGIN SELECT RAISE(ABORT, 'agent_source_erased'); END;
CREATE TRIGGER IF NOT EXISTS agent_run_steps_erasure_insert_guard BEFORE INSERT ON agent_run_steps WHEN (EXISTS (SELECT 1 FROM agent_runs r WHERE r.run_id = NEW.run_id AND r.tenant_id = NEW.tenant_id
    AND (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = r.tenant_id AND e.signal_id = r.signal_id)
      OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = r.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = r.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_signal_erasures e ON e.tenant_id = NEW.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_run_steps p ON p.tenant_id = NEW.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/'))
BEGIN SELECT RAISE(ABORT, 'agent_source_erased'); END;
CREATE TRIGGER IF NOT EXISTS agent_run_steps_erasure_update_guard BEFORE UPDATE ON agent_run_steps
WHEN ((EXISTS (SELECT 1 FROM agent_runs r WHERE r.run_id = OLD.run_id AND r.tenant_id = OLD.tenant_id
    AND (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = r.tenant_id AND e.signal_id = r.signal_id)
      OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = r.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = r.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')))
  OR EXISTS (SELECT 1 FROM json_each(OLD.sources_json) f
    JOIN agent_signal_erasures e ON e.tenant_id = OLD.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(OLD.sources_json) f
    JOIN agent_run_steps p ON p.tenant_id = OLD.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')) OR (EXISTS (SELECT 1 FROM agent_runs r WHERE r.run_id = NEW.run_id AND r.tenant_id = NEW.tenant_id
    AND (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = r.tenant_id AND e.signal_id = r.signal_id)
      OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = r.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = r.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_signal_erasures e ON e.tenant_id = NEW.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_run_steps p ON p.tenant_id = NEW.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/'))) AND NOT (
    OLD.specialist_id IS 'lead_concierge' AND OLD.action_id IS 'lead_fact.propose'
    AND json_type(OLD.args_json) IS 'object' AND json_type(OLD.args_json, '$.fields') IS 'object'
    AND json_type(OLD.args_json, '$.redacted') IS NULL
    AND NEW.args_json IS json_set(OLD.args_json, '$.fields.service', NULL, '$.fields.scope', NULL,
      '$.fields.address', NULL, '$.fields.timing', NULL, '$.redacted', json('true'))
    AND EXISTS (SELECT 1 FROM agent_runs r JOIN agent_signals s ON s.signal_id = r.signal_id AND s.tenant_id = r.tenant_id
      JOIN agent_signal_erasures e ON e.signal_id = s.signal_id AND e.tenant_id = s.tenant_id
      WHERE r.run_id = OLD.run_id AND r.tenant_id = OLD.tenant_id AND r.specialist_id IS OLD.specialist_id
        AND s.kind IS 'event' AND s.source IN ('web_form', 'instant_estimate', 'phone', 'newo_call', 'walk_in', 'office', 'gbp', 'ad', 'referral')
        AND s.subject_aggregate IS 'lead' AND s.subject_id IS json_extract(OLD.args_json, '$.lead_id')
        AND e.content_sha256 IS s.content_sha256 AND e.kind IS s.kind
        AND e.subject_aggregate IS s.subject_aggregate AND e.subject_id IS s.subject_id
        AND e.received_at IS s.received_at AND e.signal_seq_at_decision IS s.signal_seq
        AND e.marker_sha256 IS NOT NULL AND e.marker_confirmed_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM json_each(OLD.sources_json) c
          WHERE json_extract(c.value, '$.fact_id') IS 'signal/' || s.signal_id
            AND json_extract(c.value, '$.version') IS 1
            AND json_extract(c.value, '$.hash') IS 'sha256:' || s.content_sha256))
    AND NEW.step_id IS OLD.step_id
    AND NEW.tenant_id IS OLD.tenant_id
    AND NEW.run_id IS OLD.run_id
    AND NEW.step_seq IS OLD.step_seq
    AND NEW.step_key IS OLD.step_key
    AND NEW.specialist_id IS OLD.specialist_id
    AND NEW.action_id IS OLD.action_id
    AND NEW.autonomy IS OLD.autonomy
    AND NEW.args_sha256 IS OLD.args_sha256
    AND NEW.sources_json IS OLD.sources_json
    AND NEW.policy_json IS OLD.policy_json
    AND NEW.permit_json IS OLD.permit_json
    AND NEW.tool_json IS OLD.tool_json
    AND NEW.readback_json IS OLD.readback_json
    AND NEW.outcome IS OLD.outcome
    AND NEW.reason_code IS OLD.reason_code
    AND NEW.needs_reviewer_role IS OLD.needs_reviewer_role
    AND NEW.needs_person_id IS OLD.needs_person_id
    AND NEW.needs_ask IS OLD.needs_ask
    AND NEW.undo_json IS OLD.undo_json
    AND NEW.do_it_myself_json IS OLD.do_it_myself_json
    AND NEW.created_at IS OLD.created_at
    AND NEW.decided_at IS OLD.decided_at
    AND NEW.version IS OLD.version
  )
BEGIN SELECT RAISE(ABORT, 'agent_source_erased'); END;
CREATE TRIGGER IF NOT EXISTS agent_shadow_steps_erasure_insert_guard BEFORE INSERT ON agent_shadow_steps WHEN (EXISTS (SELECT 1 FROM agent_runs r WHERE r.run_id = NEW.run_id AND r.tenant_id = NEW.tenant_id
    AND (EXISTS (SELECT 1 FROM agent_signal_erasures e WHERE e.tenant_id = r.tenant_id AND e.signal_id = r.signal_id)
      OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_signal_erasures e ON e.tenant_id = r.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(r.context_json, '$.facts') f
    JOIN agent_run_steps p ON p.tenant_id = r.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/')))
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_signal_erasures e ON e.tenant_id = NEW.tenant_id AND e.signal_id = substr(json_extract(f.value, '$.fact_id'), 8, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 8)
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 7) IS 'signal/')
  OR EXISTS (SELECT 1 FROM json_each(NEW.sources_json) f
    JOIN agent_run_steps p ON p.tenant_id = NEW.tenant_id AND p.step_id = substr(json_extract(f.value, '$.fact_id'), 15, instr(json_extract(f.value, '$.fact_id') || '#', '#') - 15)
    JOIN agent_runs pr ON pr.tenant_id = p.tenant_id AND pr.run_id = p.run_id
    JOIN agent_signal_erasures e ON e.tenant_id = pr.tenant_id AND e.signal_id = pr.signal_id
    WHERE substr(json_extract(f.value, '$.fact_id'), 1, 14) IS 'lead_proposal/'))
BEGIN SELECT RAISE(ABORT, 'agent_source_erased'); END;
