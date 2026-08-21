-- 0082_envelope_operating_tenant.sql — bind owned lead envelopes to the Worker tenant.
--
-- IRO-189 D1-native synthetic-lead proof: the envelopes table is the operating
-- record. It had no tenant column, so a second APP_TENANT_ID sharing the same D1
-- could read another tenant's lead by envelope_id. Additive column only — no new
-- index or trigger — so the D1 backup/restore schema inventory counts stay at
-- 146 tables / 209 indexes / 343 triggers. Application-layer queries filter by
-- tenant_id; unverified tenant labels are refused before ingest mutation.
--
-- Numbered 0082 because main already ships 0079–0081 and IRO-195 stack PRs
-- #92–#97 own 0070–0078.

ALTER TABLE envelopes ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'ironwrap'
  CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  );
