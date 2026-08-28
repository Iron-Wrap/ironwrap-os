-- 0126_document_generation_settled_outcomes.sql - preserve settled reconciliation truth.
--
-- 0125 made terminal_status and reconciliation_outcome identical. That is correct for a
-- direct success, failure, or unknown result, but it cannot preserve the later conclusion
-- that an unknown write was not executed or requires a manual exception. Keep the shipped
-- columns compatible and add the two distinct settled outcomes as an immutable receipt fact.

ALTER TABLE document_generation_receipts
  ADD COLUMN settled_outcome TEXT CHECK (
    settled_outcome IS NULL OR settled_outcome IN ('not_executed', 'manual_exception')
  );

DROP TRIGGER IF EXISTS document_generation_receipt_insert_guard;

CREATE TRIGGER document_generation_receipt_insert_guard
BEFORE INSERT ON document_generation_receipts
BEGIN
  SELECT RAISE(ABORT, 'document_generation_receipt_duplicate')
    WHERE EXISTS (
      SELECT 1 FROM document_generation_receipts receipt
       WHERE receipt.receipt_id = NEW.receipt_id
          OR (receipt.tenant_id = NEW.tenant_id
              AND receipt.idempotency_key_hash = NEW.idempotency_key_hash)
          OR (receipt.generation_attempt_id = NEW.generation_attempt_id
              AND receipt.receipt_version = NEW.receipt_version)
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_scope_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
         AND attempt.tenant_id = NEW.tenant_id
         AND attempt.entity_type = NEW.entity_type
         AND attempt.entity_id = NEW.entity_id
         AND attempt.template_id = NEW.template_id
         AND attempt.template_revision_id = NEW.template_revision_id
         AND attempt.template_version = NEW.template_version
         AND attempt.input_snapshot_digest = NEW.input_snapshot_digest
         AND attempt.output_digest = NEW.output_digest
         AND attempt.external_effect_id = NEW.external_effect_id
         AND attempt.provider = NEW.provider
         AND attempt.authority_kind = NEW.authority_kind
         AND attempt.actor_type = NEW.actor_type
         AND attempt.actor_role = NEW.actor_role
         AND attempt.actor_id = NEW.actor_id
         AND attempt.authority_ref = NEW.authority_ref
         AND attempt.policy_ref = NEW.policy_ref
         AND attempt.policy_version = NEW.policy_version
         AND attempt.permit_expires_at IS NEW.permit_expires_at
         AND attempt.max_attempts = NEW.max_attempts
         AND attempt.stop_policy = NEW.stop_policy
         AND attempt.compensation_policy = NEW.compensation_policy
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_inputs_incomplete')
    WHERE NOT EXISTS (
      SELECT 1
        FROM document_generation_attempts attempt
       WHERE attempt.generation_attempt_id = NEW.generation_attempt_id
         AND (SELECT COUNT(*) FROM document_generation_inputs input
               WHERE input.generation_attempt_id = NEW.generation_attempt_id) = attempt.input_count
    );
  SELECT RAISE(ABORT, 'document_generation_receipt_prior_invalid')
    WHERE (NEW.receipt_version = 1 AND NEW.prior_receipt_id IS NOT NULL)
       OR (NEW.receipt_version > 1 AND NOT EXISTS (
         SELECT 1 FROM document_generation_receipts prior
          WHERE prior.receipt_id = NEW.prior_receipt_id
            AND prior.generation_attempt_id = NEW.generation_attempt_id
            AND prior.receipt_version = NEW.receipt_version - 1
            AND prior.terminal_status = 'unknown'
            AND prior.settled_outcome IS NULL
       ));
  SELECT RAISE(ABORT, 'document_generation_receipt_effect_invalid')
    WHERE NOT EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
    );
  SELECT RAISE(ABORT, 'document_generation_retry_budget_invalid')
    WHERE EXISTS (
      SELECT 1 FROM external_effects effect
       WHERE effect.effect_id = NEW.external_effect_id
         AND effect.tenant_id = NEW.tenant_id
         AND effect.provider = NEW.provider
         AND effect.intent_id = NEW.generation_attempt_id
         AND effect.action = 'document.generate'
         AND effect.aggregate_type = 'document_generation'
         AND effect.aggregate_id = NEW.generation_attempt_id
         AND effect.aggregate_version = NEW.template_version
         AND effect.retry_limit + 1 > NEW.max_attempts
    );
  SELECT RAISE(ABORT, 'document_generation_retry_budget_invalid')
    WHERE NEW.terminal_status = 'failed'
      AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.tenant_id = NEW.tenant_id
           AND effect.provider = NEW.provider
           AND effect.intent_id = NEW.generation_attempt_id
           AND effect.action = 'document.generate'
           AND effect.aggregate_type = 'document_generation'
           AND effect.aggregate_id = NEW.generation_attempt_id
           AND effect.aggregate_version = NEW.template_version
           AND effect.state = 'failed'
           AND effect.attempt_count < effect.retry_limit + 1
      );
  SELECT RAISE(ABORT, 'document_generation_receipt_terminal_invalid')
    WHERE NOT (
      (NEW.terminal_status = 'succeeded' AND NEW.settled_outcome IS NULL AND EXISTS (
        SELECT 1
          FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.state = 'succeeded'
           AND effect.provider_external_id = NEW.provider_document_id
           AND effect.readback_hash = NEW.readback_digest
           AND json_valid(effect.expected_readback_json)
           AND (SELECT COUNT(*) FROM json_each(effect.expected_readback_json)) = 12
           AND json_extract(effect.expected_readback_json, '$.schema_version') = 'ironwrap.document-generation-readback.v1'
           AND json_extract(effect.expected_readback_json, '$.tenant_id') = NEW.tenant_id
           AND json_extract(effect.expected_readback_json, '$.entity_type') = NEW.entity_type
           AND json_extract(effect.expected_readback_json, '$.entity_id') = NEW.entity_id
           AND json_extract(effect.expected_readback_json, '$.generation_attempt_id') = NEW.generation_attempt_id
           AND json_extract(effect.expected_readback_json, '$.template_id') = NEW.template_id
           AND json_extract(effect.expected_readback_json, '$.template_revision_id') = NEW.template_revision_id
           AND json_extract(effect.expected_readback_json, '$.template_version') = NEW.template_version
           AND json_extract(effect.expected_readback_json, '$.input_snapshot_digest') = NEW.input_snapshot_digest
           AND json_extract(effect.expected_readback_json, '$.provider') = NEW.provider
           AND json_extract(effect.expected_readback_json, '$.provider_document_id') = NEW.provider_document_id
           AND json_extract(effect.expected_readback_json, '$.output_digest') = NEW.output_digest
      ))
      OR (NEW.terminal_status = 'failed' AND NEW.settled_outcome IS NULL AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.state = 'failed'
           AND effect.attempt_count >= effect.retry_limit + 1
           AND effect.provider_external_id IS NEW.provider_document_id
           AND effect.readback_hash IS NEW.readback_digest
      ))
      OR (NEW.terminal_status = 'unknown' AND NEW.settled_outcome IS NULL AND
          NEW.readback_status != 'conflict' AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.state = 'unknown'
           AND effect.provider_external_id IS NEW.provider_document_id
           AND effect.readback_hash IS NEW.readback_digest
      ))
      OR (NEW.terminal_status = 'unknown' AND NEW.settled_outcome = 'manual_exception' AND
          NEW.readback_status = 'conflict' AND NEW.readback_digest IS NOT NULL AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.state = 'manual_exception'
           AND effect.provider_external_id IS NEW.provider_document_id
           AND effect.readback_hash = NEW.readback_digest
      ))
      OR (NEW.terminal_status = 'unknown' AND NEW.settled_outcome = 'not_executed' AND
          NEW.readback_status = 'not_found' AND NEW.readback_digest IS NOT NULL AND EXISTS (
        SELECT 1 FROM external_effects effect
         WHERE effect.effect_id = NEW.external_effect_id
           AND effect.state = 'reconciled'
           AND effect.provider_external_id IS NEW.provider_document_id
           AND effect.readback_hash = NEW.readback_digest
      ))
    );
END;
