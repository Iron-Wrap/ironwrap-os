// production-job-stops.ts - whether a stop applies to a roof job: the reads a Safety attestation
// (migrations 0158 and 0159) and a schedule (migration 0159) share, on the route and in D1.

import type { AppEnv } from "./app-types.ts";

/**
 * A stop that applies to the job, as migration 0158 reads it: an active safety stop on the whole
 * tenant, on the job, or on any Work Package of the job in any status, Superseded included; or a
 * crew's stop_work on any Work Package of the job that no release has lifted (0145). An active
 * safety stop whose scope cannot be resolved applies too: a scope type this rule does not know, or
 * a Work Package that maps to no job. A stop on another job, a shop or a vehicle does not. The job
 * phase's own read of active stops stays as it is: it reports job-scoped stops.
 *
 * A Safety attestation (0158) and a schedule (0159) both read it, here and in D1.
 */
export async function safetyStopActive(
  env: AppEnv,
  tenantId: string,
  roofJobId: string,
): Promise<boolean> {
  const jobPackages = `SELECT package.work_package_id FROM work_packages package
               WHERE package.tenant_id = ? AND package.job_id = ?`;
  const row = await env.DB.prepare(
    `SELECT 1 AS found
       WHERE EXISTS (
         SELECT 1
           FROM safety_occurrences occurrence
          WHERE occurrence.tenant_id = ?
            AND occurrence.stop_active = 1
            AND (
              occurrence.scope_type = 'tenant'
              OR (occurrence.scope_type = 'roof_job' AND occurrence.scope_id = ?)
              OR (occurrence.scope_type = 'work_package' AND (
                occurrence.scope_id IN (${jobPackages})
                OR NOT EXISTS (
                  SELECT 1 FROM work_packages package
                   WHERE package.tenant_id = occurrence.tenant_id
                     AND package.work_package_id = occurrence.scope_id
                )
              ))
              OR occurrence.scope_type NOT IN ('tenant', 'roof_job', 'work_package', 'shop', 'vehicle')
            )
       )
       OR EXISTS (
         SELECT 1
           FROM work_package_events crew_stop
          WHERE crew_stop.tenant_id = ?
            AND crew_stop.event_kind = 'stop_work'
            AND crew_stop.work_package_id IN (${jobPackages})
            AND NOT EXISTS (
              SELECT 1 FROM work_package_stop_releases released
               WHERE released.tenant_id = crew_stop.tenant_id
                 AND released.stop_event_id = crew_stop.event_id
            )
       )`,
  ).bind(tenantId, roofJobId, tenantId, roofJobId, tenantId, tenantId, roofJobId).first();
  return row !== null;
}

/**
 * The oldest active safety stop that names a job this tenant does not have (0158), or null. It may
 * be a typo for any job, so it holds Safety on every job of the tenant until it is lifted. The
 * refusal names the stop (`stop_id`), and the owner's exception list shows it. A stop is always
 * recorded: nothing refuses it when it is raised.
 */
export async function unknownJobStop(env: AppEnv, tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT occurrence.occurrence_id
       FROM safety_occurrences occurrence
      WHERE occurrence.tenant_id = ?
        AND occurrence.stop_active = 1
        AND occurrence.scope_type = 'roof_job'
        AND NOT EXISTS (
          SELECT 1 FROM operating_roof_jobs job
           WHERE job.tenant_id = occurrence.tenant_id AND job.roof_job_id = occurrence.scope_id
        )
      ORDER BY occurrence.reported_at, occurrence.occurrence_id
      LIMIT 1`,
  ).bind(tenantId).first<{ occurrence_id: string }>();
  return row?.occurrence_id ?? null;
}

/**
 * The oldest active safety stop that names a Work Package this tenant does not have (0159), or
 * null. It maps to no job and may be meant for a package of any of them, so it holds Safety on
 * every job of the tenant until it is lifted, as a stop on a job that doesn't exist does: the
 * refusal names the stop, and the owner's exception list shows it.
 */
export async function unknownWorkPackageStop(env: AppEnv, tenantId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT occurrence.occurrence_id
       FROM safety_occurrences occurrence
      WHERE occurrence.tenant_id = ?
        AND occurrence.stop_active = 1
        AND occurrence.scope_type = 'work_package'
        AND NOT EXISTS (
          SELECT 1 FROM work_packages package
           WHERE package.tenant_id = occurrence.tenant_id
             AND package.work_package_id = occurrence.scope_id
        )
      ORDER BY occurrence.reported_at, occurrence.occurrence_id
      LIMIT 1`,
  ).bind(tenantId).first<{ occurrence_id: string }>();
  return row?.occurrence_id ?? null;
}
