-- Refuse the second identity of the same Gmail send while old and new Worker versions overlap.
-- Old Workers write recipient-bearing keys. New Workers write opaque keys and can replay old
-- rows. This D1 guard is the shared boundary that prevents both versions from dispatching.
-- Default sends already deduplicate by request hash. Portal confirmations use their stable
-- decision task id as well, so identical content for separate decisions remains independent.
CREATE TRIGGER external_effects_gmail_key_rollover_guard
BEFORE INSERT ON external_effects
WHEN NEW.provider = 'gmail'
 AND NEW.action = 'customer.email.send'
 AND (
   (substr(NEW.idempotency_key, 1, 6) = 'gmail:'
    AND substr(NEW.idempotency_key, -64) = NEW.request_hash)
   OR substr(NEW.idempotency_key, 1, 29) = 'portal-decision-confirmation:'
 )
BEGIN
  SELECT RAISE(ABORT, 'gmail_key_rollover_conflict')
  WHERE EXISTS (
    SELECT 1 FROM external_effects AS prior
    WHERE prior.tenant_id = NEW.tenant_id
      AND prior.provider = NEW.provider
      AND prior.action = NEW.action
      AND prior.request_hash = NEW.request_hash
      AND (
        (substr(NEW.idempotency_key, 1, 6) = 'gmail:'
         AND substr(prior.idempotency_key, 1, 6) = 'gmail:'
         AND substr(prior.idempotency_key, -64) = NEW.request_hash)
        OR (substr(NEW.idempotency_key, 1, 29) = 'portal-decision-confirmation:'
            AND substr(prior.idempotency_key, 1, 29) = 'portal-decision-confirmation:'
            AND prior.task_id = NEW.task_id)
      )
  );
END;
