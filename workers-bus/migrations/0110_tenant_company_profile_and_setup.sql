-- 0110_tenant_company_profile_and_setup.sql
-- The two owned aggregates behind the in-app company setup and the Settings hub.
--
-- 1. `tenant_company_profiles` is the tenant's own answer to "who is this company":
--    the business name, the brand a customer sees, one contact phone, one address,
--    and the three operating conventions every later read model needs (time zone,
--    currency, week start). It is D1 because it is owned operating configuration
--    with one writer, an authority (owner/ops), an optimistic version, and an audit
--    requirement -- not because it is product data. `logo_ref` is a reference only;
--    this migration stores no bytes and grants no upload authority.
--
-- 2. `tenant_company_profile_revisions` is the append-only evidence for every
--    accepted update: who, when, from which version, under which idempotency key,
--    and the exact accepted field set. Corrections add a row; they never overwrite
--    one. The unique idempotency index is what makes a replayed submission return
--    the first outcome instead of writing a second revision.
--
-- 3. `app_user_notification_preferences` is per person, not per tenant: work stops,
--    approvals waiting, and an optional daily summary with a send time. This is a
--    preference record only. Nothing here delivers a notification, schedules one, or
--    grants any outbound authority; a delivery mechanism is a separate capability
--    with its own consent, effect ledger, and reconciliation contract.

CREATE TABLE IF NOT EXISTS tenant_company_profiles (
  tenant_id TEXT PRIMARY KEY CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  -- Monotonic per tenant. A writer states the version it read; a mismatch is a
  -- conflict, never a silent overwrite of the other office user's edit.
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 1000000),
  -- Identity and operating conventions are required from the first save: without them
  -- there is no company to name and no way to read a date or a price.
  company_name TEXT NOT NULL CHECK (length(trim(company_name)) BETWEEN 1 AND 120),
  brand_name TEXT NOT NULL CHECK (length(trim(brand_name)) BETWEEN 1 AND 80),
  -- Contact and address may be saved empty and filled in later, which is what lets the
  -- setup checklist show a genuine "in progress" instead of forcing one perfect save.
  -- Empty or valid; never a half-length value.
  phone TEXT NOT NULL CHECK (
    length(trim(phone)) = 0 OR length(trim(phone)) BETWEEN 7 AND 32
  ),
  address_line1 TEXT NOT NULL CHECK (length(trim(address_line1)) BETWEEN 0 AND 160),
  city TEXT NOT NULL CHECK (length(trim(city)) BETWEEN 0 AND 80),
  -- Province/state. Canadian tenants use the two-letter code the public request
  -- form already validates; the column stays wide enough for other jurisdictions.
  region TEXT NOT NULL CHECK (
    length(trim(region)) = 0 OR length(trim(region)) BETWEEN 2 AND 80
  ),
  postal_code TEXT NOT NULL CHECK (
    length(trim(postal_code)) = 0 OR length(trim(postal_code)) BETWEEN 3 AND 24
  ),
  -- IANA identifier, the same shape `publicTenant()` already requires of the
  -- deployment default it overrides.
  time_zone TEXT NOT NULL CHECK (
    length(time_zone) BETWEEN 3 AND 64
    AND instr(time_zone, '/') > 1
    AND time_zone NOT GLOB '*[^A-Za-z0-9_/+.-]*'
  ),
  currency TEXT NOT NULL CHECK (length(currency) = 3 AND currency NOT GLOB '*[^A-Z]*'),
  week_start TEXT NOT NULL CHECK (week_start IN ('sunday', 'monday', 'saturday')),
  -- A reference to a logo held elsewhere (an R2 key or a same-origin path). Never
  -- image bytes, never a third-party URL: a remote reference would let tenant
  -- configuration point the app shell at an origin the Worker does not control.
  -- `//host/logo.png` is refused explicitly -- it passes a leading-slash test but a
  -- browser resolves it as a protocol-relative URL to another origin.
  logo_ref TEXT CHECK (
    logo_ref IS NULL OR (
      length(trim(logo_ref)) BETWEEN 1 AND 300
      AND logo_ref NOT GLOB '*[^A-Za-z0-9._:/?=&-]*'
      AND (
        (substr(logo_ref, 1, 1) = '/' AND substr(logo_ref, 1, 2) != '//')
        OR substr(logo_ref, 1, 5) = 'r2://'
      )
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  updated_by_user_id TEXT NOT NULL CHECK (
    length(updated_by_user_id) BETWEEN 8 AND 200
    AND updated_by_user_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
  ),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS tenant_company_profile_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) BETWEEN 8 AND 200
    AND revision_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  profile_version INTEGER NOT NULL CHECK (profile_version BETWEEN 1 AND 1000000),
  -- NULL for the first revision: there was no prior version to have read.
  from_profile_version INTEGER CHECK (
    from_profile_version IS NULL OR from_profile_version BETWEEN 1 AND 1000000
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 160
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  -- SHA-256 of the exact normalized accepted field set. A repeat of the same key
  -- with a different body is a conflict, not a replay.
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  accepted_json TEXT NOT NULL CHECK (
    length(trim(accepted_json)) BETWEEN 2 AND 4000
    AND substr(trim(accepted_json), 1, 1) = '{'
  ),
  actor_user_id TEXT NOT NULL CHECK (
    length(actor_user_id) BETWEEN 8 AND 200
    AND actor_user_id NOT GLOB '*[^A-Za-z0-9._:@-]*'
  ),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('owner', 'ops')),
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, profile_version),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_tenant_company_profile_revisions_tenant_recorded
  ON tenant_company_profile_revisions (tenant_id, recorded_at DESC, profile_version DESC);

CREATE TABLE IF NOT EXISTS app_user_notification_preferences (
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  user_id TEXT NOT NULL REFERENCES app_users(user_id) ON DELETE CASCADE,
  work_stops INTEGER NOT NULL CHECK (work_stops IN (0, 1)),
  approvals_waiting INTEGER NOT NULL CHECK (approvals_waiting IN (0, 1)),
  daily_summary INTEGER NOT NULL CHECK (daily_summary IN (0, 1)),
  -- Local wall-clock HH:MM in the tenant's time zone. Required exactly when the
  -- daily summary is on, so a stored preference can never be half a schedule.
  daily_summary_send_time TEXT CHECK (
    daily_summary_send_time IS NULL OR (
      length(daily_summary_send_time) = 5
      AND substr(daily_summary_send_time, 3, 1) = ':'
      AND substr(daily_summary_send_time, 1, 2) NOT GLOB '*[^0-9]*'
      AND substr(daily_summary_send_time, 4, 2) NOT GLOB '*[^0-9]*'
      AND CAST(substr(daily_summary_send_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
      AND CAST(substr(daily_summary_send_time, 4, 2) AS INTEGER) BETWEEN 0 AND 59
    )
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 160
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_fingerprint_sha256 TEXT NOT NULL CHECK (
    length(request_fingerprint_sha256) = 64
    AND request_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (tenant_id, user_id),
  CHECK (daily_summary = 0 OR daily_summary_send_time IS NOT NULL),
  CHECK (daily_summary = 1 OR daily_summary_send_time IS NULL),
  CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_app_user_notification_preferences_tenant
  ON app_user_notification_preferences (tenant_id, updated_at DESC);
