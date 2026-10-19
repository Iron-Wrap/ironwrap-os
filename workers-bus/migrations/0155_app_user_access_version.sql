-- 0155_app_user_access_version.sql - a person's access carries a version, so a change is applied
-- only against the access it was decided on.
--
-- access.change in docs/AI-TEAM-CONTRACT.md binds expected_access_version. The role, access and
-- provisioning routes now require the version the deciding person saw, bump it in the same write,
-- and refuse a stale one (access_version_conflict). Every existing person starts at 1.

ALTER TABLE app_users ADD COLUMN access_version INTEGER NOT NULL DEFAULT 1
  CHECK (access_version >= 1);
