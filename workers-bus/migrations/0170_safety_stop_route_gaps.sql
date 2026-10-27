-- 0170_safety_stop_route_gaps.sql - an active safety stop holds work on every job it names, for
-- every crew, and on every job of the tenant when the job or Work Package it names doesn't exist.
--
-- Before this migration D1 never consulted a safety stop when a crew acknowledged, started or
-- completed a Work Package: only the Worker's readiness gate did, and it matched a stop's exact
-- scope. A stop on a job or Work Package this tenant does not have held nothing, and a stop on one
-- Work Package of a job held none of that job's other packages. The Worker now applies A3's
-- Safety-gate predicate (0158) and this guard repeats it for any write, not only the Worker's:
--
-- - a `tenant` stop holds every job, whatever its `scope_id`;
-- - a `roof_job` stop holds its job, and every job when `operating_roof_jobs` has no such job;
-- - a `work_package` stop holds the job of every version of that package, Superseded included,
--   and every job when `work_packages` has no such package.
--
-- Only an active stop holds (`stop_active = 1`). Shop and vehicle stops hold no job. Stopping work
-- (`stop_work`) is never refused, and nor is any capture: a person may always stop work, and the
-- photos that release a stop are taken while it holds the job.
--
-- Office made-safe (P33): any person may say an area is made safe, but a record made away from the
-- site stands only on a named on-site confirmer. A `make_safe` event whose actor is not a field
-- worker names that confirmer (`confirmed_by_user_id`): an active user of this tenant who shares no
-- identity with the recorder (user id, email or Frappe user, compared both ways as 0165 compares a
-- releaser). No other event names one. An occurrence moves `reported -> made_safe` only with that
-- version's own `make_safe` event already written, so the rule holds for any write.
--
-- Keep the stop (P33): a person who may release a stop and decides not to records that decision,
-- with a reason, in `safety_stop_keep_decisions`. It changes nothing on the occurrence. The record
-- is append-only, names the version the person saw (still current, the stop still active), and
-- takes its time from D1's clock. Its keeper holds owner, ops or production at that moment and
-- shares no identity with the raiser.
--
-- Adds one column, one table, one index and seven triggers.

CREATE TRIGGER work_package_events_safety_stop_guard
BEFORE INSERT ON work_package_events
WHEN NEW.event_kind IN ('acknowledged', 'start_work', 'complete_work')
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_active')
  WHERE EXISTS (
    SELECT 1
      FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.stop_active = 1
       AND (
         occurrence.scope_type = 'tenant'
         OR (occurrence.scope_type = 'roof_job' AND (
           occurrence.scope_id = NEW.job_id
           OR NOT EXISTS (
             SELECT 1
               FROM operating_roof_jobs job
              WHERE job.tenant_id = occurrence.tenant_id
                AND job.roof_job_id = occurrence.scope_id
           )
         ))
         OR (occurrence.scope_type = 'work_package' AND (
           EXISTS (
             SELECT 1
               FROM work_packages package
              WHERE package.tenant_id = occurrence.tenant_id
                AND package.work_package_id = occurrence.scope_id
                AND package.job_id = NEW.job_id
           )
           OR NOT EXISTS (
             SELECT 1
               FROM work_packages package
              WHERE package.tenant_id = occurrence.tenant_id
                AND package.work_package_id = occurrence.scope_id
           )
         ))
       )
  );
END;

ALTER TABLE safety_occurrence_events ADD COLUMN confirmed_by_user_id TEXT;

CREATE TRIGGER safety_occurrence_events_make_safe_confirmer
BEFORE INSERT ON safety_occurrence_events
BEGIN
  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_not_applicable')
  WHERE NEW.confirmed_by_user_id IS NOT NULL AND NEW.event_kind != 'make_safe';

  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_required')
  WHERE NEW.event_kind = 'make_safe'
    AND NEW.actor_role != 'field'
    AND NEW.confirmed_by_user_id IS NULL;

  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_unknown')
  WHERE NEW.confirmed_by_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM app_users confirmer
       WHERE confirmer.tenant_id = NEW.tenant_id
         AND confirmer.user_id = NEW.confirmed_by_user_id
         AND confirmer.active = 1
    );

  -- The confirmer is someone other than the person recording it, under any identity.
  SELECT RAISE(ABORT, 'safety_make_safe_confirmer_is_recorder')
  WHERE NEW.confirmed_by_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM app_users confirmer
        JOIN app_users recorder
          ON recorder.tenant_id = confirmer.tenant_id
         AND recorder.user_id = NEW.actor_user_id
       WHERE confirmer.tenant_id = NEW.tenant_id
         AND confirmer.user_id = NEW.confirmed_by_user_id
         AND (
           lower(confirmer.user_id) IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
           OR confirmer.email_normalized IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
           OR lower(trim(confirmer.frappe_user_id)) IN (
             lower(recorder.user_id), recorder.email_normalized, lower(trim(recorder.frappe_user_id))
           )
         )
    );
END;

CREATE TRIGGER safety_occurrences_made_safe_event_guard
BEFORE UPDATE ON safety_occurrences
WHEN OLD.state = 'reported' AND NEW.state = 'made_safe'
BEGIN
  SELECT RAISE(ABORT, 'safety_make_safe_event_required')
  WHERE NOT EXISTS (
    SELECT 1
      FROM safety_occurrence_events event
     WHERE event.tenant_id = NEW.tenant_id
       AND event.occurrence_id = NEW.occurrence_id
       AND event.occurrence_version = NEW.version
       AND event.event_kind = 'make_safe'
  );
END;

CREATE TABLE IF NOT EXISTS safety_stop_keep_decisions (
  keep_id TEXT PRIMARY KEY CHECK (
    length(keep_id) = 36 AND keep_id GLOB 'ssk_*' AND substr(keep_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 8 AND 140
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  occurrence_id TEXT NOT NULL,
  occurrence_version INTEGER NOT NULL CHECK (occurrence_version BETWEEN 1 AND 1000000),
  kept_by_user_id TEXT NOT NULL,
  kept_by_role TEXT NOT NULL CHECK (kept_by_role IN ('owner', 'ops', 'production')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 3 AND 4000),
  kept_at TEXT NOT NULL CHECK (length(kept_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (occurrence_id, tenant_id)
    REFERENCES safety_occurrences(occurrence_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (kept_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_safety_stop_keep_decisions_occurrence
  ON safety_stop_keep_decisions (tenant_id, occurrence_id, kept_at DESC);

CREATE TRIGGER safety_stop_keep_decisions_validate_insert
BEFORE INSERT ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_actor_unknown')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users keeper
     WHERE keeper.tenant_id = NEW.tenant_id
       AND keeper.user_id = NEW.kept_by_user_id
       AND keeper.active = 1
       AND COALESCE(keeper.access_role, keeper.role) = NEW.kept_by_role
  );

  SELECT RAISE(ABORT, 'safety_occurrence_not_found')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id AND occurrence.occurrence_id = NEW.occurrence_id
  );

  SELECT RAISE(ABORT, 'safety_stop_already_released')
  WHERE EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.stop_active != 1
  );

  -- The decision names the version the person reviewed, and it is still the current one.
  SELECT RAISE(ABORT, 'safety_occurrence_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1 FROM safety_occurrences occurrence
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND occurrence.version = NEW.occurrence_version
  );

  -- Keeping is the release decision's other answer, so the raiser never records it either.
  SELECT RAISE(ABORT, 'safety_stop_release_by_raiser_forbidden')
  WHERE EXISTS (
    SELECT 1
      FROM safety_occurrences occurrence
      JOIN app_users keeper
        ON keeper.tenant_id = occurrence.tenant_id
       AND keeper.user_id = NEW.kept_by_user_id
     WHERE occurrence.tenant_id = NEW.tenant_id
       AND occurrence.occurrence_id = NEW.occurrence_id
       AND (
         lower(trim(occurrence.reported_by_user_id)) IN (
           lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
         )
         OR EXISTS (
           SELECT 1
             FROM app_users raiser
            WHERE raiser.tenant_id = occurrence.tenant_id
              AND raiser.user_id = occurrence.reported_by_user_id
              AND (
                lower(raiser.user_id) IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
                OR raiser.email_normalized IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
                OR lower(trim(raiser.frappe_user_id)) IN (
                  lower(keeper.user_id), keeper.email_normalized, lower(trim(keeper.frappe_user_id))
                )
              )
         )
       )
  );

  -- When it was kept is D1's clock, not the caller's.
  SELECT RAISE(ABORT, 'safety_stop_keep_clock_invalid')
  WHERE NEW.kept_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER safety_stop_keep_decisions_no_insert_replace
BEFORE INSERT ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_append_only')
  WHERE EXISTS (
    SELECT 1 FROM safety_stop_keep_decisions existing
     WHERE existing.keep_id = NEW.keep_id
        OR (existing.tenant_id = NEW.tenant_id AND existing.idempotency_key = NEW.idempotency_key)
  );
END;

CREATE TRIGGER safety_stop_keep_decisions_append_only_update
BEFORE UPDATE ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_append_only');
END;

CREATE TRIGGER safety_stop_keep_decisions_append_only_delete
BEFORE DELETE ON safety_stop_keep_decisions
BEGIN
  SELECT RAISE(ABORT, 'safety_stop_keep_retained');
END;
