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
-- Adds one trigger.

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
