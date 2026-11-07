-- 0210_external_effect_gateway_admissions.sql — what the HELM gateway said about each effect.
--
-- Every provider mutation passes `executeExternalEffect` (effect-runtime.ts). Behind
-- HELM_GATEWAY_BINDING the Worker proposes the effect to the HELM gateway first
-- (helm-gateway.ts) and records the answer here before it claims an attempt: admitted, denied
-- with the gateway's reason code, escalated to a person, or unreachable. In `enforce` mode only
-- an admitted row lets the attempt proceed; in `shadow` mode the row is evidence and nothing
-- blocks. The ledger row itself (`external_effects`) is not widened: the fixtures that test the
-- ledger apply 0042/0062/0142 alone, and an admission is a fact about one proposal, not a column
-- of the effect.
--
-- `receipt_ref_json` holds the gateway's signed receipt references (helm-tracker#276: chain id,
-- sequence, receipt hash, key id) once the gateway returns them; NULL until then.
--
-- Append-only: an admission is never edited or deleted. One table, one named index, two
-- triggers: the D1 backup/restore inventory moves to 290 tables, 397 indexes (384 named idx_%)
-- and 818 triggers.

CREATE TABLE IF NOT EXISTS external_effect_gateway_admissions (
  admission_id TEXT PRIMARY KEY CHECK (length(admission_id) BETWEEN 8 AND 260),
  effect_id TEXT NOT NULL CHECK (length(effect_id) BETWEEN 1 AND 200),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  -- The attempt this admission was asked for (attempt_count + 1 at the time).
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 1000),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'enforce')),
  decision TEXT NOT NULL CHECK (decision IN ('admitted', 'denied', 'escalated', 'unreachable')),
  -- The gateway's reason code (EFFECT_OUT_OF_SCOPE, PER_CALL_LIMIT, APPROVAL_REQUIRED, ...) or
  -- the client's own (gateway_timeout, gateway_http_503, gateway_token_missing, ...).
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 120),
  -- What the gateway called the effect: its effect type and attempt id, and the state it reported.
  effect_type TEXT NOT NULL CHECK (length(effect_type) BETWEEN 1 AND 128),
  gateway_attempt_id TEXT CHECK (gateway_attempt_id IS NULL OR length(gateway_attempt_id) BETWEEN 1 AND 200),
  gateway_state TEXT CHECK (gateway_state IS NULL OR length(gateway_state) BETWEEN 1 AND 64),
  -- sha256 of the exact argument bytes sent, so the gateway's argument_digest can be matched.
  argument_digest TEXT NOT NULL CHECK (length(argument_digest) = 64 AND argument_digest NOT GLOB '*[^0-9a-f]*'),
  receipt_ref_json TEXT CHECK (receipt_ref_json IS NULL OR (json_valid(receipt_ref_json) AND json_type(receipt_ref_json) = 'array')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40)
);

CREATE INDEX IF NOT EXISTS idx_external_effect_gateway_admissions_effect
  ON external_effect_gateway_admissions (effect_id, attempt_number);

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admissions_append_only_update
BEFORE UPDATE ON external_effect_gateway_admissions BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS external_effect_gateway_admissions_append_only_delete
BEFORE DELETE ON external_effect_gateway_admissions BEGIN
  SELECT RAISE(ABORT, 'external_effect_gateway_admissions_append_only');
END;
