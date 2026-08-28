-- 0128_automation_recipient_catalog.sql - tenant-administered automation recipients (ELEC-204).
--
-- Until now the set of destinations a stage-change automation could deliver to lived in
-- PIPELINE_AUTOMATION_RECIPIENTS_JSON, a deploy secret. An administrator could pick from whatever
-- an engineer had pre-populated; adding "the shop" required rotating a secret and redeploying.
-- That is configuration-by-developer on the stakeholder's first-priority automation.
--
-- This migration gives a tenant its own catalog, with the same shape every other administered
-- aggregate in this schema already uses: a CAS-protected head pointing at append-only revisions
-- that carry actor attribution, so "who changed where the shop's mail goes, and when" is
-- answerable after the fact.
--
-- What the rule stores does NOT change. A rule still carries `recipient_ref` and never an address;
-- this table is the only place a destination exists, and resolution happens at dispatch. The
-- closed-catalog property - the rule builder cannot accept a raw address - is preserved exactly.
--
-- `channel` is a transport discriminator, deliberately NOT pinned by a column CHECK to one literal:
-- 0127 had to rebuild two tables to widen such a CHECK. The registry of transports is closed in
-- code (`AUTOMATION_RECIPIENT_CHANNELS`), so registering SMS later is a code change, not a table
-- rebuild. Nothing here names a vertical: "the shop" is a row an administrator writes.

CREATE TABLE IF NOT EXISTS automation_recipient_heads (
  recipient_id TEXT PRIMARY KEY CHECK (
    length(recipient_id) BETWEEN 12 AND 200
    AND recipient_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  -- The stable key a rule references. Immutable for the life of the record: revising a recipient
  -- re-points where it delivers, it never renames what a rule is bound to.
  recipient_ref TEXT NOT NULL CHECK (
    length(recipient_ref) BETWEEN 1 AND 120
    AND recipient_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  current_revision_id TEXT,
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version BETWEEN 0 AND 1000000),
  created_by TEXT NOT NULL CHECK (length(created_by) BETWEEN 1 AND 160),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (recipient_id, tenant_id),
  -- One record per reference per tenant. Two tenants may both name a recipient `shop`; the
  -- composite key is what keeps them separate rows that no query can join across.
  UNIQUE (tenant_id, recipient_ref)
);

CREATE INDEX IF NOT EXISTS idx_automation_recipient_heads_tenant
  ON automation_recipient_heads (tenant_id, recipient_ref);

CREATE TABLE IF NOT EXISTS automation_recipient_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) BETWEEN 12 AND 200
    AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  recipient_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 1000000),
  prior_revision_id TEXT,
  recipient_ref TEXT NOT NULL CHECK (
    length(recipient_ref) BETWEEN 1 AND 120
    AND recipient_ref NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  action TEXT NOT NULL CHECK (action IN ('create', 'revise', 'retire')),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  channel TEXT NOT NULL CHECK (
    length(channel) BETWEEN 3 AND 40
    AND channel NOT GLOB '*[^a-z._-]*'
  ),
  -- The destination itself. It is stored here because tenant-administered data has to live
  -- somewhere the tenant can administer it; it is never written to a rule row, an invocation row,
  -- or any API response. Readers get `destination_digest` and the masked form the API derives.
  destination TEXT NOT NULL CHECK (
    length(destination) BETWEEN 3 AND 320
    AND destination NOT GLOB '*[^ -~]*'
    AND destination NOT GLOB '* *'
  ),
  destination_digest TEXT NOT NULL CHECK (
    length(destination_digest) = 64 AND destination_digest NOT GLOB '*[^0-9a-f]*'
  ),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  actor_role TEXT NOT NULL CHECK (length(actor_role) BETWEEN 2 AND 40),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 160),
  command_fingerprint TEXT NOT NULL CHECK (
    length(command_fingerprint) = 64 AND command_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (revision_id, tenant_id),
  UNIQUE (tenant_id, recipient_id, version),
  UNIQUE (tenant_id, idempotency_key_hash),
  -- A retirement is the only way `active` reaches 0, and it can never carry a live destination
  -- claim: retire and re-activate are separate, separately attributed commands.
  CHECK ((action = 'retire' AND active = 0) OR (action != 'retire' AND active = 1)),
  FOREIGN KEY (recipient_id, tenant_id)
    REFERENCES automation_recipient_heads(recipient_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (prior_revision_id, tenant_id)
    REFERENCES automation_recipient_revisions(revision_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_automation_recipient_revisions_record
  ON automation_recipient_revisions (tenant_id, recipient_id, version DESC);

-- The head is a pointer and nothing else: identity is immutable, the version only ever advances by
-- one, and it may only ever point at a revision that exists and belongs to it.
CREATE TRIGGER automation_recipient_heads_identity_guard
BEFORE UPDATE ON automation_recipient_heads
BEGIN
  SELECT RAISE(ABORT, 'automation_recipient_head_identity_immutable')
    WHERE NEW.recipient_id != OLD.recipient_id OR NEW.tenant_id != OLD.tenant_id
       OR NEW.recipient_ref != OLD.recipient_ref
       OR NEW.created_by != OLD.created_by OR NEW.created_at != OLD.created_at;
  SELECT RAISE(ABORT, 'automation_recipient_head_version_conflict')
    WHERE NEW.current_version != OLD.current_version + 1;
  SELECT RAISE(ABORT, 'automation_recipient_head_pointer_invalid')
    WHERE NEW.current_version < 1 OR NEW.current_revision_id IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM automation_recipient_revisions r
          WHERE r.tenant_id = NEW.tenant_id AND r.recipient_id = NEW.recipient_id
            AND r.revision_id = NEW.current_revision_id AND r.version = NEW.current_version
            AND r.recipient_ref = NEW.recipient_ref
       );
END;

CREATE TRIGGER automation_recipient_revisions_lineage_guard
BEFORE INSERT ON automation_recipient_revisions
BEGIN
  SELECT RAISE(ABORT, 'automation_recipient_revision_head_missing')
    WHERE NOT EXISTS (
      SELECT 1 FROM automation_recipient_heads h
       WHERE h.tenant_id = NEW.tenant_id AND h.recipient_id = NEW.recipient_id
         AND h.recipient_ref = NEW.recipient_ref
    );
  SELECT RAISE(ABORT, 'automation_recipient_revision_version_conflict')
    WHERE NOT EXISTS (
      SELECT 1 FROM automation_recipient_heads h
       WHERE h.tenant_id = NEW.tenant_id AND h.recipient_id = NEW.recipient_id
         AND NEW.version = h.current_version + 1
         AND NEW.prior_revision_id IS h.current_revision_id
    );
  SELECT RAISE(ABORT, 'automation_recipient_revision_action_invalid')
    WHERE NEW.version = 1 AND NEW.action != 'create';
  SELECT RAISE(ABORT, 'automation_recipient_revision_action_invalid')
    WHERE NEW.version > 1 AND NEW.action = 'create';
END;

CREATE TRIGGER automation_recipient_revisions_append_only_update
BEFORE UPDATE ON automation_recipient_revisions
BEGIN SELECT RAISE(ABORT, 'automation_recipient_revisions_append_only'); END;
CREATE TRIGGER automation_recipient_revisions_append_only_delete
BEFORE DELETE ON automation_recipient_revisions
BEGIN SELECT RAISE(ABORT, 'automation_recipient_revisions_append_only'); END;
CREATE TRIGGER automation_recipient_revisions_no_insert_replace
BEFORE INSERT ON automation_recipient_revisions
BEGIN
  SELECT RAISE(ABORT, 'automation_recipient_revisions_append_only')
    WHERE EXISTS (
      SELECT 1 FROM automation_recipient_revisions r
       WHERE r.revision_id = NEW.revision_id
          OR (r.tenant_id = NEW.tenant_id AND r.recipient_id = NEW.recipient_id
              AND r.version = NEW.version)
    );
END;
