-- 0080_replay_requests_envelope_idx.sql - per-envelope lookup for the automated dead-letter
-- reconciliation sweep (ELEC-52 / IRO-194).
--
-- The sweep derives its attempt cap and backoff clock from the existing replay_requests ledger
-- rather than from envelopes.attempts, which bumpAttempt and bumpErpNextMirrorAttempt already
-- own for unrelated intake/mirror retries. That makes replay_requests the hot path for a query
-- keyed on (envelope_id, approved_by) and ordered by created_at, which the table's only existing
-- index -- idx_replay_requests_status_updated -- cannot serve: without this, every five-minute
-- tick table-scans the ledger once per dead envelope.
--
-- approved_by sits between the two columns the sweep's design note names because the sweep always
-- pins it to a single constant identity, so created_at stays sorted within each matched group.
-- Additive and expand-only: no shipped migration is touched and no data is rewritten.

CREATE INDEX IF NOT EXISTS idx_replay_requests_envelope_approver_created
  ON replay_requests (envelope_id, approved_by, created_at);
