-- 0163_customer_portal_proposal_views.sql - the first time a customer's portal link opened a
-- published proposal.
--
-- "Elena opened this proposal" needs a fact the portal does not keep. `customer_portal_links` holds
-- one `last_accessed_at` that every visit overwrites and that names no proposal. This table keeps
-- one row per portal link and proposal publication, never updated: when someone holding that link
-- first opened that published proposal. A later open of the same publication through the same link
-- adds nothing; a new link or a new publication starts its own row. A row means "someone holding
-- the customer's link opened it", never "the customer read it".
--
-- It stores ids and one timestamp. It stores no IP address, user agent or location, and no history
-- of later visits. The Worker writes it only while APP_CUSTOMER_PORTAL_PROPOSAL_VIEWS_ENABLED is
-- "true", which stays off until the owner approves the portal privacy notice that says the first
-- open is recorded and kept for at most 3 years.
--
-- Retention: at most 3 years (owner decision). A row cannot be deleted while it is younger than 3
-- years by D1's own clock; the daily cron deletes the older ones before it prunes portal links. The
-- link prune keeps every link that a row names, so the foreign key below never blocks it.
--
-- D1 repeats what the writer checks:
-- - the link is the row's own: same tenant, job and customer, and not revoked or expired when the
--   open happened;
-- - the publication is a `published` event of that proposal pack and revision, and the revision is
--   for that job and customer;
-- - `first_viewed_at` is within 60 seconds of D1's own clock, so no writer can backdate an open;
-- - the row is never updated, REPLACE cannot rewrite it, and it is deleted only once it is older
--   than 3 years.
-- The ids are checked against their own tables, which carry their own shape checks.

CREATE TABLE IF NOT EXISTS customer_portal_proposal_views (
  view_id TEXT PRIMARY KEY CHECK (
    length(view_id) = 76
    AND substr(view_id, 1, 12) = 'portal-view:'
    AND substr(view_id, 13) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  link_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  proposal_pack_id TEXT NOT NULL,
  proposal_revision_id TEXT NOT NULL,
  publication_event_id TEXT NOT NULL,
  first_viewed_at TEXT NOT NULL CHECK (
    length(first_viewed_at) = 24
    AND first_viewed_at GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
  ),
  UNIQUE (tenant_id, link_id, publication_event_id),
  FOREIGN KEY (link_id) REFERENCES customer_portal_links(link_id) ON DELETE RESTRICT
);

-- The retention prune: the oldest rows first.
CREATE INDEX IF NOT EXISTS idx_customer_portal_proposal_views_first_viewed
  ON customer_portal_proposal_views (first_viewed_at);

CREATE TRIGGER IF NOT EXISTS customer_portal_proposal_views_validate_insert
BEFORE INSERT ON customer_portal_proposal_views
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_proposal_view_link_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM customer_portal_links link
     WHERE link.link_id = NEW.link_id
       AND link.tenant_id = NEW.tenant_id
       AND link.roof_job_id = NEW.roof_job_id
       AND link.customer_id = NEW.customer_id
  );
  SELECT RAISE(ABORT, 'customer_portal_proposal_view_link_not_live')
  WHERE EXISTS (
    SELECT 1
      FROM customer_portal_links link
     WHERE link.link_id = NEW.link_id
       AND (julianday(link.expires_at) <= julianday(NEW.first_viewed_at)
            OR (link.revoked_at IS NOT NULL
                AND julianday(link.revoked_at) <= julianday(NEW.first_viewed_at)))
  );
  SELECT RAISE(ABORT, 'customer_portal_proposal_view_publication_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
      FROM commercial_proposal_publication_events publication
      JOIN commercial_proposal_revisions proposal
        ON proposal.proposal_revision_id = publication.proposal_revision_id
       AND proposal.tenant_id = publication.tenant_id
     WHERE publication.publication_event_id = NEW.publication_event_id
       AND publication.tenant_id = NEW.tenant_id
       AND publication.state = 'published'
       AND publication.proposal_pack_id = NEW.proposal_pack_id
       AND publication.proposal_revision_id = NEW.proposal_revision_id
       AND proposal.roof_job_id = NEW.roof_job_id
       AND proposal.customer_id = NEW.customer_id
  );
  SELECT RAISE(ABORT, 'customer_portal_proposal_view_clock_skew')
  WHERE julianday(NEW.first_viewed_at) IS NULL
     OR abs(julianday(NEW.first_viewed_at) - julianday('now')) * 86400.0 > 60;
END;

CREATE TRIGGER IF NOT EXISTS customer_portal_proposal_views_append_only_update
BEFORE UPDATE ON customer_portal_proposal_views
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_proposal_views_append_only');
END;

-- 3 years is the maximum retention: a row younger than that by D1's own clock is never deleted.
-- Both sides use the stored format, so the comparison is exact.
CREATE TRIGGER IF NOT EXISTS customer_portal_proposal_views_append_only_delete
BEFORE DELETE ON customer_portal_proposal_views
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_proposal_views_append_only')
  WHERE NOT (OLD.first_viewed_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 years'));
END;

-- REPLACE would delete the first open before inserting another, and an internal delete fires no
-- DELETE trigger on D1 (0062). Refuse any conflicting key first. Created last, so it fires first.
CREATE TRIGGER IF NOT EXISTS customer_portal_proposal_views_no_insert_replace
BEFORE INSERT ON customer_portal_proposal_views
BEGIN
  SELECT RAISE(ABORT, 'customer_portal_proposal_views_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM customer_portal_proposal_views existing
     WHERE existing.view_id = NEW.view_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.link_id = NEW.link_id
            AND existing.publication_event_id = NEW.publication_event_id)
  );
END;
