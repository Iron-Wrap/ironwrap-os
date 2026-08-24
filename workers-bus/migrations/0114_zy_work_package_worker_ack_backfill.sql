-- 0114_zy_work_package_worker_ack_backfill.sql - repair acknowledgements missed by shipped 0107.
--
-- 0107 created the per-worker projection and its forward trigger, but events
-- recorded before that migration were not projected. Keep 0107 immutable and
-- fill only absent actor/package rows from the append-only event authority.

INSERT INTO work_package_worker_acknowledgements (
  tenant_id, work_package_id, work_package_version, actor_user_id, actor_role,
  event_id, device_action_id, occurred_at, created_at
)
SELECT
  event.tenant_id,
  event.work_package_id,
  event.work_package_version,
  event.actor_user_id,
  event.actor_role,
  event.event_id,
  event.device_action_id,
  event.occurred_at,
  event.created_at
FROM work_package_events event
WHERE event.event_kind = 'acknowledged'
  AND NOT EXISTS (
    SELECT 1
    FROM work_package_worker_acknowledgements acknowledgement
    WHERE acknowledgement.tenant_id = event.tenant_id
      AND acknowledgement.work_package_id = event.work_package_id
      AND acknowledgement.work_package_version = event.work_package_version
      AND acknowledgement.actor_user_id = event.actor_user_id
  );
