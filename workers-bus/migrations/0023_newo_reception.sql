-- 0023_newo_reception.sql - durable Newo event, session, control, and slot state.

CREATE TABLE IF NOT EXISTS newo_event_receipts (
  event_id       TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload_hash   TEXT NOT NULL,
  raw_key        TEXT NOT NULL,
  envelope_id    TEXT,
  status         TEXT NOT NULL CHECK (status IN ('processing','accepted','failed','dead')),
  response_json  TEXT NOT NULL DEFAULT '{}',
  attempts       INTEGER NOT NULL DEFAULT 1,
  last_error     TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  completed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_newo_receipts_session
  ON newo_event_receipts (session_id, first_seen_at);
CREATE INDEX IF NOT EXISTS idx_newo_receipts_status
  ON newo_event_receipts (status, last_seen_at);

CREATE TABLE IF NOT EXISTS newo_sessions (
  session_id             TEXT PRIMARY KEY,
  project_id             TEXT,
  agent_id               TEXT,
  user_actor_id          TEXT,
  conversation_id        TEXT,
  channel                TEXT NOT NULL DEFAULT 'phone',
  direction              TEXT NOT NULL DEFAULT 'inbound',
  status                 TEXT NOT NULL,
  outcome                TEXT,
  contact_name           TEXT,
  contact_phone          TEXT,
  contact_email          TEXT,
  address_line1          TEXT,
  city                   TEXT,
  province               TEXT,
  postal_code            TEXT,
  division               TEXT,
  service                TEXT,
  urgency                TEXT,
  lead_envelope_id       TEXT,
  appointment_request_id TEXT,
  handoff_status         TEXT,
  booking_status         TEXT,
  summary                TEXT,
  transcript_ref         TEXT,
  recording_ref          TEXT,
  ai_disclosed           INTEGER NOT NULL DEFAULT 0,
  recording_disclosed    INTEGER NOT NULL DEFAULT 0,
  structured_json        TEXT NOT NULL,
  raw_key                TEXT NOT NULL,
  payload_hash           TEXT NOT NULL,
  started_at             TEXT,
  ended_at               TEXT,
  duration_seconds       INTEGER,
  sync_status            TEXT NOT NULL DEFAULT 'pending',
  sync_attempts          INTEGER NOT NULL DEFAULT 0,
  last_error             TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_newo_sessions_status
  ON newo_sessions (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_newo_sessions_sync
  ON newo_sessions (sync_status, updated_at);
CREATE INDEX IF NOT EXISTS idx_newo_sessions_phone
  ON newo_sessions (contact_phone, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_newo_sessions_appointment
  ON newo_sessions (appointment_request_id)
  WHERE appointment_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS newo_control_actions (
  action_id               TEXT PRIMARY KEY,
  operation               TEXT NOT NULL,
  args_hash               TEXT NOT NULL,
  args_json               TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('previewed','approved','executing','completed','failed')),
  requested_by            TEXT NOT NULL,
  approved_by             TEXT,
  dry_run_receipt_hash    TEXT,
  approval_receipt_hash   TEXT,
  provider_response_hash  TEXT,
  last_error              TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  completed_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_newo_control_status
  ON newo_control_actions (status, updated_at);

CREATE TABLE IF NOT EXISTS newo_slot_reservations (
  reservation_id  TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  slot_id         TEXT NOT NULL,
  slot_token_hash TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('held','booked','expired','cancelled')),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (session_id, slot_id)
);
CREATE INDEX IF NOT EXISTS idx_newo_slots_expiry
  ON newo_slot_reservations (status, expires_at);
