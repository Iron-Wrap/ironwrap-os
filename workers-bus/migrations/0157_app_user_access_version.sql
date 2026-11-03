-- 0157_app_user_access_version.sql - a person's access carries a version, so a change is applied
-- only against the access it was decided on.
--
-- access.change in docs/AI-TEAM-CONTRACT.md binds expected_access_version. The role, access and
-- provisioning routes now require the version the deciding person saw, bump it in the same write,
-- and refuse a stale one (access_version_conflict); an accepted invitation that gives a removed
-- person access back bumps it the same way. Every existing person starts at 1.
--
-- Each of those writes commits its audit row in the same batch, and the row carries the change as
-- JSON in access_change: {"v": the version it produced, "before": {"role", "active"} or null for a
-- new person, "after": {"role", "active"}, "actor": the deciding user's id}. A refused change reads
-- what moved since its own version from these rows with json_extract. detail_code keeps its short
-- text; at 120 characters it cannot hold the JSON.

ALTER TABLE app_users ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1
  CHECK (access_version >= 1);

ALTER TABLE app_auth_audit ADD COLUMN access_change TEXT
  CHECK (access_change IS NULL OR json_valid(access_change));
