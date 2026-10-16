-- A crew stop cannot be lifted by a correction reason or a direct D1 write.
-- A later independent-release workflow must bind a status release to a verified
-- human decision before it can permit a replacement package.
CREATE TRIGGER work_package_supersessions_blocked_guard
BEFORE INSERT ON work_package_supersessions
WHEN EXISTS (
  SELECT 1 FROM work_packages prior
   WHERE prior.tenant_id = NEW.tenant_id
     AND prior.work_package_id = NEW.prior_work_package_id
     AND prior.version = NEW.prior_work_package_version
     AND prior.status = 'Blocked'
)
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_required');
END;

-- Historical acknowledgement/start facts remain in the event ledger after a stop.
-- They must not authorize moving the stopped projection back to an earlier state.
CREATE TRIGGER work_packages_blocked_status_guard
BEFORE UPDATE OF status ON work_packages
WHEN OLD.status = 'Blocked' AND NEW.status != 'Blocked'
BEGIN
  SELECT RAISE(ABORT, 'work_package_stop_release_required');
END;
