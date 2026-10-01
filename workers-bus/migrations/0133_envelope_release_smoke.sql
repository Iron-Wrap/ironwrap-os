-- 0133_envelope_release_smoke.sql
--
-- Expand-only: mark the rows a production release proof created (IRO-264).
--
-- The tag-triggered production release runs the launch proof against production,
-- so its fixture leads land in the real operating store. They are owned writes and
-- are deliberately kept, but an operator reading the envelope table has no way to
-- tell a release probe from a customer. This column is that distinction, recorded
-- at insert time by the request scope rather than inferred later from the fixture
-- email.
--
-- Default 0 and NOT NULL, so every existing row is a real lead and no reader has
-- to handle NULL. No trigger guard: the column carries no invariant beyond its
-- default, and the writer is the only thing that ever sets it to 1. No index
-- either: nothing queries by it on a hot path, and adding one would change the
-- recovery object inventory for a column that is read by hand.

ALTER TABLE envelopes ADD COLUMN release_smoke INTEGER NOT NULL DEFAULT 0;
