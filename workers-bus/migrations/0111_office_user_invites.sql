-- 0111_office_user_invites.sql - office-issued, one-time, expiring, revocable user invites.
--
-- Same credential shape as the Field Companion device pairing (0014): the raw invite secret is a
-- high-entropy browser value that is emailed once and never persisted. Only its fixed-length
-- SHA-256 hash is stored, so a database export contains no reusable credential.
--
-- An invite grants exactly one access role to exactly one normalized email inside one tenant. It
-- does not create a session and it does not carry a password: accepting it materializes the
-- app_users grant, after which the invitee signs in through the existing magic-link path.
--
-- At most one invite per (tenant, email) may be open at a time. A second issuance supersedes the
-- first in the same D1 batch, so two office tabs cannot leave two live secrets for one person.

CREATE TABLE IF NOT EXISTS app_user_invites (
  invite_id TEXT PRIMARY KEY CHECK (
    length(invite_id) BETWEEN 12 AND 80
    AND invite_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  email_normalized TEXT NOT NULL CHECK (
    length(email_normalized) BETWEEN 3 AND 254
    AND email_normalized = lower(trim(email_normalized))
    AND instr(email_normalized, '@') > 1
  ),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- The effective application role, exactly the app_users.access_role vocabulary. An invite can
  -- never grant something the session layer cannot express.
  access_role TEXT NOT NULL CHECK (
    access_role IN ('owner', 'ops', 'sales', 'production', 'accounting', 'field')
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  invited_by_user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40),
  last_sent_at TEXT NOT NULL CHECK (length(last_sent_at) BETWEEN 20 AND 40),
  resend_count INTEGER NOT NULL DEFAULT 0 CHECK (resend_count BETWEEN 0 AND 100),
  accepted_at TEXT,
  accepted_user_id TEXT REFERENCES app_users(user_id) ON DELETE RESTRICT,
  revoked_at TEXT,
  revoked_by_user_id TEXT REFERENCES app_users(user_id) ON DELETE RESTRICT,
  -- `superseded` is what a re-issue does to the invite it replaces; `office_revoked` is a person
  -- deliberately taking the invitation back. Both close the credential; only one is a withdrawal.
  revoked_reason TEXT CHECK (
    revoked_reason IS NULL OR revoked_reason IN ('office_revoked', 'superseded')
  ),
  issued_ip_hash TEXT NOT NULL CHECK (length(issued_ip_hash) = 64),
  issued_user_agent_hash TEXT NOT NULL CHECK (length(issued_user_agent_hash) = 64),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  -- An invite is accepted or withdrawn, never both. The accept path and the revoke path each
  -- compare-and-set against both columns, and this makes the impossible row unrepresentable.
  CHECK (accepted_at IS NULL OR revoked_at IS NULL),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK (revoked_reason != 'office_revoked' OR revoked_by_user_id IS NOT NULL),
  FOREIGN KEY (invited_by_user_id, tenant_id) REFERENCES app_users(user_id, tenant_id)
);

-- One live invitation per person. A partial unique index is the storage-level statement of the
-- rule the issuing batch enforces, so a concurrent second issuance fails rather than doubling
-- the number of usable secrets for one mailbox.
CREATE UNIQUE INDEX IF NOT EXISTS app_user_invites_one_open_uidx
  ON app_user_invites (tenant_id, email_normalized)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_app_user_invites_tenant_created
  ON app_user_invites (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_user_invites_expiry
  ON app_user_invites (expires_at, accepted_at, revoked_at);

-- Local-development capture gains the invite href, for the same reason 0022 and 0066 exist: a
-- local stack must be able to complete the real accept flow without sending real email. Writer
-- and reader stay gated on APP_ALLOW_INSECURE_LOCAL="true", which every deployed environment
-- pins to "false". SQLite cannot widen a CHECK in place, so the dev-only table is rebuilt; it is
-- never populated in a deployed environment, so the copy below is a no-op there.

CREATE TABLE IF NOT EXISTS dev_outbox_invite_new (
  capture_id TEXT PRIMARY KEY CHECK (
    length(capture_id) BETWEEN 12 AND 80
    AND capture_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('magic_link', 'contract_acceptance', 'user_invite')),
  recipient TEXT NOT NULL CHECK (length(recipient) BETWEEN 3 AND 320),
  href TEXT NOT NULL CHECK (length(href) BETWEEN 16 AND 2048),
  created_at TEXT NOT NULL
);

INSERT INTO dev_outbox_invite_new (capture_id, kind, recipient, href, created_at)
SELECT capture_id, kind, recipient, href, created_at FROM dev_outbox;

DROP TABLE dev_outbox;

ALTER TABLE dev_outbox_invite_new RENAME TO dev_outbox;

CREATE INDEX IF NOT EXISTS idx_dev_outbox_created ON dev_outbox (created_at DESC);
