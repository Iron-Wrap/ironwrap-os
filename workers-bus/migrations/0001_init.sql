-- 0001_init.sql — owned system of record for the IronWrap bus.
-- Apply: wrangler d1 migrations apply ironwrap-bus --local   (or --remote)

CREATE TABLE IF NOT EXISTS envelopes (
  envelope_id   TEXT PRIMARY KEY,            -- ow_<uuid>
  source        TEXT NOT NULL,               -- website|phone|gbp|ad|referral|manual
  contact_name  TEXT,
  contact_phone TEXT,                         -- E.164-ish, e.g. +15875551234
  contact_email TEXT,
  job_ref       TEXT,                         -- JobNimbus job number once known
  payload_json  TEXT NOT NULL,               -- canonical envelope payload
  raw_key       TEXT,                         -- R2 key of the raw inbound body
  ts            TEXT NOT NULL,               -- ISO 8601 event time
  status        TEXT NOT NULL,               -- received|pending_jn_push|pushed|reconciled|duplicate|dead
  dedup_key     TEXT,                         -- p:<phone> or e:<email>
  dup_of        TEXT,                         -- envelope_id of the original, when duplicate
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  jn_contact_id TEXT,
  jn_job_id     TEXT,
  intent_queue  TEXT,                         -- routed owner queue
  created_at    TEXT NOT NULL,               -- ISO 8601
  updated_at    TEXT NOT NULL                -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_env_dedup  ON envelopes (dedup_key, created_at);
CREATE INDEX IF NOT EXISTS idx_env_status ON envelopes (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_env_day    ON envelopes (created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,               -- ISO 8601
  automation    TEXT,
  trigger       TEXT,
  envelope_id   TEXT,
  source_ids    TEXT,
  target_ids    TEXT,
  job_number    TEXT,
  action        TEXT,
  result        TEXT,                         -- ok|error
  error         TEXT,
  recovery_owner TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_env ON audit_log (envelope_id);

CREATE TABLE IF NOT EXISTS dead_letter (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,                -- ISO 8601
  envelope_id  TEXT,
  stage        TEXT,
  error        TEXT,
  payload_json TEXT,
  recovered    INTEGER NOT NULL DEFAULT 0
);

-- Independent ground-truth counts (Twilio call logs, form-provider/Cloudflare logs, GBP).
CREATE TABLE IF NOT EXISTS source_counts (
  day     TEXT NOT NULL,                     -- YYYY-MM-DD (UTC)
  channel TEXT NOT NULL,
  count   INTEGER NOT NULL,
  PRIMARY KEY (day, channel)
);

CREATE TABLE IF NOT EXISTS heartbeat (
  day              TEXT PRIMARY KEY,         -- YYYY-MM-DD (UTC)
  ran_at           TEXT NOT NULL,           -- ISO 8601
  reconciled       INTEGER NOT NULL,         -- 1 = green (no gaps)
  dead_letter_open INTEGER NOT NULL
);
