-- 0021_public_estimate_rate_limits.sql - secondary, privacy-preserving abuse guard.
--
-- Turnstile remains the primary public-bot control. This ledger stores only
-- keyed hashes of the Cloudflare client IP and client submission id; raw IPs,
-- raw client ids, contact data, and Turnstile tokens never enter this table.

CREATE TABLE IF NOT EXISTS public_estimate_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'client')),
  subject_hash TEXT NOT NULL CHECK (
    length(subject_hash) = 64
    AND subject_hash NOT GLOB '*[^0-9a-f]*'
  ),
  window_started_at TEXT NOT NULL,
  window_expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, subject_hash),
  CHECK (window_expires_at > window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_public_estimate_rate_limits_expiry
  ON public_estimate_rate_limits (window_expires_at);
