-- Dedicated, false-by-default Hermes desktop text pilot.
--
-- Pairing and access capabilities are stored only as SHA-256 digests. Every
-- downstream record repeats the full tenant/user/device/pairing binding and
-- proves it with a composite foreign key. Provider inputs and results are
-- canonical JSON plus independent digests so desktop and hosted-reference
-- execution can be compared without either path gaining write authority.

CREATE TABLE IF NOT EXISTS hermes_desktop_pairings (
  pairing_id TEXT PRIMARY KEY CHECK (length(pairing_id) BETWEEN 8 AND 140),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  api_audience TEXT NOT NULL CHECK (
    length(api_audience) BETWEEN 8 AND 512
    AND api_audience = trim(api_audience)
    AND instr(api_audience, char(0)) = 0
  ),
  bound_issuer TEXT NOT NULL CHECK (
    length(bound_issuer) BETWEEN 3 AND 512
    AND bound_issuer = trim(bound_issuer)
    AND instr(bound_issuer, char(0)) = 0
  ),
  bound_origin TEXT NOT NULL CHECK (
    length(bound_origin) BETWEEN 8 AND 512
    AND bound_origin = trim(bound_origin)
    AND instr(bound_origin, char(0)) = 0
  ),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_device_id TEXT,
  CHECK (expires_at > issued_at),
  CHECK (
    (consumed_at IS NULL AND consumed_device_id IS NULL) OR
    (
      consumed_at IS NOT NULL
      AND consumed_device_id IS NOT NULL
      AND consumed_at >= issued_at
      AND consumed_at < expires_at
    )
  ),
  UNIQUE (pairing_id, tenant_id, user_id, role),
  UNIQUE (
    pairing_id, tenant_id, user_id, role, api_audience, bound_issuer,
    bound_origin
  ),
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (consumed_device_id, pairing_id, tenant_id, user_id, role)
    REFERENCES hermes_desktop_devices(
      device_id, pairing_id, tenant_id, user_id, role
    ) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hermes_desktop_pairings_user_expiry
  ON hermes_desktop_pairings(tenant_id, user_id, expires_at, consumed_at);

CREATE TABLE IF NOT EXISTS hermes_desktop_devices (
  device_id TEXT PRIMARY KEY CHECK (length(device_id) BETWEEN 8 AND 140),
  pairing_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  api_audience TEXT NOT NULL,
  bound_issuer TEXT NOT NULL,
  bound_origin TEXT NOT NULL,
  connector_capabilities_json TEXT NOT NULL CHECK (
    length(connector_capabilities_json) BETWEEN 2 AND 16384
    AND json_valid(connector_capabilities_json)
  ),
  device_name TEXT NOT NULL CHECK (
    length(device_name) BETWEEN 1 AND 80
    AND instr(device_name, char(0)) = 0
  ),
  device_proof_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(device_proof_sha256) = 64
    AND device_proof_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  access_token_sha256 TEXT NOT NULL UNIQUE CHECK (
    length(access_token_sha256) = 64
    AND access_token_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  access_expires_at TEXT NOT NULL,
  paired_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revoked_by_user_id TEXT,
  CHECK (access_expires_at > paired_at),
  CHECK (last_seen_at IS NULL OR last_seen_at >= paired_at),
  CHECK (
    (revoked_at IS NULL AND revoked_by_user_id IS NULL) OR
    (
      revoked_at IS NOT NULL
      AND revoked_by_user_id IS NOT NULL
      AND revoked_at >= paired_at
    )
  ),
  UNIQUE (device_id, pairing_id, tenant_id, user_id, role),
  FOREIGN KEY (
    pairing_id, tenant_id, user_id, role, api_audience, bound_issuer,
    bound_origin
  ) REFERENCES hermes_desktop_pairings(
    pairing_id, tenant_id, user_id, role, api_audience, bound_issuer,
    bound_origin
  ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (revoked_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hermes_desktop_devices_binding_active
  ON hermes_desktop_devices(
    tenant_id, user_id, role, access_expires_at, revoked_at
  );

CREATE TABLE IF NOT EXISTS hermes_desktop_envelopes (
  envelope_id TEXT PRIMARY KEY CHECK (length(envelope_id) BETWEEN 8 AND 140),
  version TEXT NOT NULL CHECK (version = 'task_envelope_v1'),
  workflow TEXT NOT NULL CHECK (workflow = 'lead_follow_up_draft'),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  device_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  lead_envelope_id TEXT NOT NULL,
  roof_job_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('Email', 'SMS')),
  recipient_ref TEXT NOT NULL,
  consent_id TEXT NOT NULL,
  consent_basis TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('issued', 'staged', 'submitted')),
  context_sha256 TEXT NOT NULL CHECK (
    length(context_sha256) = 64
    AND context_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
  provider_request_json TEXT NOT NULL CHECK (
    length(provider_request_json) BETWEEN 2 AND 131072
    AND json_valid(provider_request_json)
  ),
  provider_request_sha256 TEXT NOT NULL CHECK (
    length(provider_request_sha256) = 64
    AND provider_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  output_schema_sha256 TEXT NOT NULL CHECK (
    length(output_schema_sha256) = 64
    AND output_schema_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  messages_sha256 TEXT NOT NULL CHECK (
    length(messages_sha256) = 64
    AND messages_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  submitted_at TEXT,
  CHECK (expires_at > issued_at),
  CHECK (
    (state <> 'submitted' AND submitted_at IS NULL) OR
    (
      state = 'submitted'
      AND submitted_at IS NOT NULL
      AND submitted_at >= issued_at
      AND submitted_at < expires_at
    )
  ),
  UNIQUE (
    envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ),
  UNIQUE (
    envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ),
  FOREIGN KEY (device_id, pairing_id, tenant_id, user_id, role)
    REFERENCES hermes_desktop_devices(
      device_id, pairing_id, tenant_id, user_id, role
    ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hermes_desktop_envelopes_device_state_expiry
  ON hermes_desktop_envelopes(device_id, state, expires_at, issued_at);

CREATE TABLE IF NOT EXISTS hermes_desktop_contexts (
  context_id TEXT PRIMARY KEY CHECK (length(context_id) BETWEEN 8 AND 140),
  envelope_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  device_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  prior_context_sha256 TEXT NOT NULL CHECK (
    length(prior_context_sha256) = 64
    AND prior_context_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  context_sha256 TEXT NOT NULL CHECK (
    length(context_sha256) = 64
    AND context_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  observations_json TEXT NOT NULL CHECK (json_valid(observations_json)),
  calendar_slots_json TEXT NOT NULL CHECK (json_valid(calendar_slots_json)),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  provider_request_json TEXT NOT NULL CHECK (
    length(provider_request_json) BETWEEN 2 AND 131072
    AND json_valid(provider_request_json)
  ),
  provider_request_sha256 TEXT NOT NULL CHECK (
    length(provider_request_sha256) = 64
    AND provider_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  output_schema_sha256 TEXT NOT NULL CHECK (
    length(output_schema_sha256) = 64
    AND output_schema_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  messages_sha256 TEXT NOT NULL CHECK (
    length(messages_sha256) = 64
    AND messages_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  staged_at TEXT NOT NULL,
  UNIQUE (
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ),
  UNIQUE (
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ),
  FOREIGN KEY (
    envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) REFERENCES hermes_desktop_envelopes(
    envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS hermes_desktop_results (
  result_id TEXT PRIMARY KEY CHECK (length(result_id) BETWEEN 8 AND 140),
  envelope_id TEXT NOT NULL,
  context_id TEXT,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  device_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  context_sha256 TEXT NOT NULL CHECK (
    length(context_sha256) = 64
    AND context_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider_request_sha256 TEXT NOT NULL CHECK (
    length(provider_request_sha256) = 64
    AND provider_request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  source_channel TEXT NOT NULL CHECK (
    source_channel IN ('desktop', 'hosted_reference')
  ),
  idempotency_key_sha256 TEXT NOT NULL CHECK (
    length(idempotency_key_sha256) = 64
    AND idempotency_key_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  input_sha256 TEXT NOT NULL CHECK (
    length(input_sha256) = 64
    AND input_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'uncertain')),
  validation_sha256 TEXT NOT NULL CHECK (
    length(validation_sha256) = 64
    AND validation_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  handoff_sha256 TEXT NOT NULL CHECK (
    length(handoff_sha256) = 64
    AND handoff_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_sha256 TEXT NOT NULL CHECK (
    length(result_sha256) = 64
    AND result_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  result_json TEXT NOT NULL CHECK (
    length(result_json) BETWEEN 2 AND 131072
    AND json_valid(result_json)
  ),
  recorded_at TEXT NOT NULL,
  UNIQUE (
    result_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ),
  FOREIGN KEY (
    envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ) REFERENCES hermes_desktop_envelopes(
    envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ) REFERENCES hermes_desktop_contexts(
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role,
    context_sha256, provider_request_sha256
  ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hermes_desktop_results_one_accepted_handoff
  ON hermes_desktop_results(envelope_id)
  WHERE outcome = 'accepted';

CREATE UNIQUE INDEX IF NOT EXISTS idx_hermes_desktop_results_idempotency_identity
  ON hermes_desktop_results(tenant_id, user_id, idempotency_key_sha256);

CREATE TABLE IF NOT EXISTS hermes_desktop_events (
  event_id TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 8 AND 140),
  event_type TEXT NOT NULL CHECK (event_type IN (
    'pairing_issued',
    'pairing_consumed',
    'device_revoked',
    'task_issued',
    'context_staged',
    'hosted_call_started',
    'draft_result_recorded'
  )),
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'ops')),
  pairing_id TEXT NOT NULL,
  device_id TEXT,
  envelope_id TEXT,
  context_id TEXT,
  result_id TEXT,
  detail_sha256 TEXT NOT NULL CHECK (
    length(detail_sha256) = 64
    AND detail_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (event_type = 'pairing_issued'
      AND device_id IS NULL AND envelope_id IS NULL
      AND context_id IS NULL AND result_id IS NULL)
    OR
    (event_type = 'pairing_consumed'
      AND device_id IS NOT NULL AND envelope_id IS NULL
      AND context_id IS NULL AND result_id IS NULL)
    OR
    (event_type = 'device_revoked'
      AND device_id IS NOT NULL AND envelope_id IS NULL
      AND context_id IS NULL AND result_id IS NULL)
    OR
    (event_type = 'task_issued'
      AND device_id IS NOT NULL AND envelope_id IS NOT NULL
      AND context_id IS NULL AND result_id IS NULL)
    OR
    (event_type = 'context_staged'
      AND device_id IS NOT NULL AND envelope_id IS NOT NULL
      AND context_id IS NOT NULL AND result_id IS NULL)
    OR
    (event_type = 'hosted_call_started'
      AND device_id IS NOT NULL AND envelope_id IS NOT NULL
      AND result_id IS NULL)
    OR
    (event_type = 'draft_result_recorded'
      AND device_id IS NOT NULL AND envelope_id IS NOT NULL
      AND result_id IS NOT NULL)
  ),
  FOREIGN KEY (pairing_id, tenant_id, user_id, role)
    REFERENCES hermes_desktop_pairings(
      pairing_id, tenant_id, user_id, role
    ) ON DELETE RESTRICT,
  FOREIGN KEY (device_id, pairing_id, tenant_id, user_id, role)
    REFERENCES hermes_desktop_devices(
      device_id, pairing_id, tenant_id, user_id, role
    ) ON DELETE RESTRICT,
  FOREIGN KEY (
    envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) REFERENCES hermes_desktop_envelopes(
    envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) REFERENCES hermes_desktop_contexts(
    context_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) ON DELETE RESTRICT,
  FOREIGN KEY (
    result_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) REFERENCES hermes_desktop_results(
    result_id, envelope_id, device_id, pairing_id, tenant_id, user_id, role
  ) ON DELETE RESTRICT,
  FOREIGN KEY (user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_hermes_desktop_events_tenant_created
  ON hermes_desktop_events(tenant_id, created_at, event_id);

CREATE TRIGGER IF NOT EXISTS hermes_desktop_pairings_binding_immutable
BEFORE UPDATE ON hermes_desktop_pairings
WHEN
  NEW.pairing_id <> OLD.pairing_id OR
  NEW.token_sha256 <> OLD.token_sha256 OR
  NEW.tenant_id <> OLD.tenant_id OR
  NEW.user_id <> OLD.user_id OR
  NEW.role <> OLD.role OR
  NEW.api_audience <> OLD.api_audience OR
  NEW.bound_issuer <> OLD.bound_issuer OR
  NEW.bound_origin <> OLD.bound_origin OR
  NEW.issued_at <> OLD.issued_at OR
  NEW.expires_at <> OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_pairing_binding_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_pairings_consumption_monotonic
BEFORE UPDATE OF consumed_at, consumed_device_id ON hermes_desktop_pairings
WHEN NOT (
  (
    OLD.consumed_at IS NULL AND OLD.consumed_device_id IS NULL
    AND NEW.consumed_at IS NULL AND NEW.consumed_device_id IS NULL
  )
  OR
  (
    OLD.consumed_at IS NULL AND OLD.consumed_device_id IS NULL
    AND NEW.consumed_at IS NOT NULL AND NEW.consumed_device_id IS NOT NULL
    AND NEW.consumed_at >= OLD.issued_at
    AND NEW.consumed_at < OLD.expires_at
  )
  OR
  (
    OLD.consumed_at IS NOT NULL AND OLD.consumed_device_id IS NOT NULL
    AND NEW.consumed_at IS OLD.consumed_at
    AND NEW.consumed_device_id IS OLD.consumed_device_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_pairing_consumption_not_monotonic');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_devices_binding_immutable
BEFORE UPDATE ON hermes_desktop_devices
WHEN
  NEW.device_id <> OLD.device_id OR
  NEW.pairing_id <> OLD.pairing_id OR
  NEW.tenant_id <> OLD.tenant_id OR
  NEW.user_id <> OLD.user_id OR
  NEW.role <> OLD.role OR
  NEW.api_audience <> OLD.api_audience OR
  NEW.bound_issuer <> OLD.bound_issuer OR
  NEW.bound_origin <> OLD.bound_origin OR
  NEW.connector_capabilities_json <> OLD.connector_capabilities_json OR
  NEW.device_name <> OLD.device_name OR
  NEW.device_proof_sha256 <> OLD.device_proof_sha256 OR
  NEW.access_token_sha256 <> OLD.access_token_sha256 OR
  NEW.access_expires_at <> OLD.access_expires_at OR
  NEW.paired_at <> OLD.paired_at
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_device_binding_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_devices_revocation_monotonic
BEFORE UPDATE OF revoked_at, revoked_by_user_id ON hermes_desktop_devices
WHEN NOT (
  (
    OLD.revoked_at IS NULL AND OLD.revoked_by_user_id IS NULL
    AND NEW.revoked_at IS NULL AND NEW.revoked_by_user_id IS NULL
  )
  OR
  (
    OLD.revoked_at IS NULL AND OLD.revoked_by_user_id IS NULL
    AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by_user_id IS NOT NULL
    AND NEW.revoked_at >= OLD.paired_at
  )
  OR
  (
    OLD.revoked_at IS NOT NULL AND OLD.revoked_by_user_id IS NOT NULL
    AND NEW.revoked_at IS OLD.revoked_at
    AND NEW.revoked_by_user_id IS OLD.revoked_by_user_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_device_revocation_not_monotonic');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_envelopes_binding_immutable
BEFORE UPDATE ON hermes_desktop_envelopes
WHEN
  NEW.envelope_id <> OLD.envelope_id OR
  NEW.version <> OLD.version OR
  NEW.workflow <> OLD.workflow OR
  NEW.tenant_id <> OLD.tenant_id OR
  NEW.user_id <> OLD.user_id OR
  NEW.role <> OLD.role OR
  NEW.device_id <> OLD.device_id OR
  NEW.pairing_id <> OLD.pairing_id OR
  NEW.lead_id <> OLD.lead_id OR
  NEW.lead_envelope_id <> OLD.lead_envelope_id OR
  NEW.roof_job_id IS NOT OLD.roof_job_id OR
  NEW.channel <> OLD.channel OR
  NEW.recipient_ref <> OLD.recipient_ref OR
  NEW.consent_id <> OLD.consent_id OR
  NEW.consent_basis <> OLD.consent_basis OR
  NEW.issued_at <> OLD.issued_at OR
  NEW.expires_at <> OLD.expires_at
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_envelope_binding_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_envelopes_state_transition
BEFORE UPDATE ON hermes_desktop_envelopes
WHEN NOT (
  (
    NEW.state = OLD.state
    AND NEW.context_sha256 = OLD.context_sha256
    AND NEW.context_json = OLD.context_json
    AND NEW.envelope_json = OLD.envelope_json
    AND NEW.provider_request_json = OLD.provider_request_json
    AND NEW.provider_request_sha256 = OLD.provider_request_sha256
    AND NEW.output_schema_sha256 = OLD.output_schema_sha256
    AND NEW.messages_sha256 = OLD.messages_sha256
    AND NEW.submitted_at IS OLD.submitted_at
  )
  OR
  (
    OLD.state = 'issued' AND NEW.state = 'staged'
    AND NEW.submitted_at IS NULL
    AND EXISTS (
      SELECT 1
      FROM hermes_desktop_contexts AS context
      WHERE context.envelope_id = OLD.envelope_id
        AND context.device_id = OLD.device_id
        AND context.pairing_id = OLD.pairing_id
        AND context.tenant_id = OLD.tenant_id
        AND context.user_id = OLD.user_id
        AND context.role = OLD.role
        AND context.context_sha256 = NEW.context_sha256
        AND context.provider_request_json = NEW.provider_request_json
        AND context.provider_request_sha256 = NEW.provider_request_sha256
        AND context.output_schema_sha256 = NEW.output_schema_sha256
        AND context.messages_sha256 = NEW.messages_sha256
        AND context.staged_at < OLD.expires_at
    )
  )
  OR
  (
    OLD.state IN ('issued', 'staged') AND NEW.state = 'submitted'
    AND NEW.context_sha256 = OLD.context_sha256
    AND NEW.context_json = OLD.context_json
    AND NEW.envelope_json = OLD.envelope_json
    AND NEW.provider_request_json = OLD.provider_request_json
    AND NEW.provider_request_sha256 = OLD.provider_request_sha256
    AND NEW.output_schema_sha256 = OLD.output_schema_sha256
    AND NEW.messages_sha256 = OLD.messages_sha256
    AND NEW.submitted_at IS NOT NULL
    AND NEW.submitted_at >= OLD.issued_at
    AND NEW.submitted_at < OLD.expires_at
    AND EXISTS (
      SELECT 1
      FROM hermes_desktop_results AS result
      WHERE result.envelope_id = OLD.envelope_id
        AND result.device_id = OLD.device_id
        AND result.pairing_id = OLD.pairing_id
        AND result.tenant_id = OLD.tenant_id
        AND result.user_id = OLD.user_id
        AND result.role = OLD.role
        AND result.context_sha256 = OLD.context_sha256
        AND result.provider_request_sha256 = OLD.provider_request_sha256
        AND result.outcome = 'accepted'
        AND result.recorded_at = NEW.submitted_at
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_envelope_state_transition_invalid');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_contexts_immutable_update
BEFORE UPDATE ON hermes_desktop_contexts
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_contexts_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_contexts_immutable_delete
BEFORE DELETE ON hermes_desktop_contexts
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_contexts_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_results_append_only_update
BEFORE UPDATE ON hermes_desktop_results
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_results_append_only');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_results_append_only_delete
BEFORE DELETE ON hermes_desktop_results
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_results_append_only');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_events_immutable_update
BEFORE UPDATE ON hermes_desktop_events
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_events_immutable');
END;

CREATE TRIGGER IF NOT EXISTS hermes_desktop_events_immutable_delete
BEFORE DELETE ON hermes_desktop_events
BEGIN
  SELECT RAISE(ABORT, 'hermes_desktop_events_immutable');
END;
