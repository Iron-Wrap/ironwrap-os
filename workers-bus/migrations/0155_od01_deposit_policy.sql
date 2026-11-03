-- 0155_od01_deposit_policy.sql - the tenant's deposit policy decides which contract may be signed,
-- and a contract with no deposit clears the Deposit gate by policy.
--
-- 1. `tenant_deposit_policy_revisions` is the owner's append-only, revisioned setting. The policy
--    in force is the latest revision, and a tenant with none is `od01_payment_on_completion`,
--    because no prepaid licence is the safe default:
--      * `od01_payment_on_completion` (OD-01): a contract has no deposit and is paid on completion,
--        `deposit_percent: 0` with `payment_schedule: ["completion"]`;
--      * `md13_deposit` (MD-13): a contract carries a deposit of 1 to 100 percent.
--    Only an active owner records a revision, never the QA seed owner, with a reason, naming the
--    revision after the one they read. Each revision writes its one `audit_log` row as it lands.
-- 2. Acceptance follows the policy. 0116's `commercial_acceptance_enqueue_deposit_derivation` is
--    re-created under its name with its other rules unchanged: OD-01 accepts only the contract
--    with no deposit and enqueues no derivation, MD-13 keeps 0116's 1-100 rule, and anything else
--    aborts. The Worker refuses such terms by name earlier; this abort is the backstop.
-- 3. The Deposit gate's policy entries. 0153's `production_gate_clearances_validate_insert` is
--    re-created under its name with every 0153 rule kept, so the ledger's rules stay in one place;
--    the additions are marked [0155]:
--      * `clear` / `contract_no_deposit` by `policy`: the job's latest accepted contract has no
--        deposit and the tenant is OD-01. Recorded by policy, with the contract version as
--        evidence; it is not a waiver and not a person's call, and it reads "No deposit under
--        this contract";
--      * `reverse` / `contract_superseded` by `policy`: a later accepted contract carries a
--        deposit, so Deposit returns to blocked. From then on a settlement must be that contract's
--        own deposit invoice, or the owner waives;
--      * a person never reverses `contract_no_deposit`.
--    0153's replace guard is re-created unchanged after it, so it still fires first.
--
-- The Worker appends the Deposit entry after an acceptance commits, never inside it, so a failed
-- entry never fails an acceptance; the five-minute sweep appends any entry that is missing.
--
-- This file may apply after higher-numbered migrations already on a database (0156-0167 and
-- 0200-0206 on qa). It creates its own table and four triggers and re-creates 0116's enqueue
-- trigger and two 0153 guards; no higher-numbered migration touches any of them.

CREATE TABLE IF NOT EXISTS tenant_deposit_policy_revisions (
  revision_id TEXT PRIMARY KEY CHECK (
    length(revision_id) = 44
    AND substr(revision_id, 1, 4) = 'tdp_'
    AND substr(revision_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  -- 1 for the first revision; each later one is the revision after the one its writer read.
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
  policy TEXT NOT NULL CHECK (policy IN ('od01_payment_on_completion', 'md13_deposit')),
  reason TEXT NOT NULL CHECK (length(trim(reason)) BETWEEN 1 AND 1000),
  set_by_user_id TEXT NOT NULL CHECK (
    length(set_by_user_id) BETWEEN 8 AND 200
    AND set_by_user_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  set_by_role TEXT NOT NULL CHECK (set_by_role = 'owner'),
  request_sha256 TEXT NOT NULL CHECK (
    length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  set_at TEXT NOT NULL CHECK (length(set_at) BETWEEN 20 AND 40),
  UNIQUE (tenant_id, revision),
  UNIQUE (tenant_id, idempotency_key_hash),
  FOREIGN KEY (set_by_user_id, tenant_id)
    REFERENCES app_users(user_id, tenant_id) ON DELETE RESTRICT
);

CREATE TRIGGER IF NOT EXISTS tenant_deposit_policy_revisions_validate_insert
BEFORE INSERT ON tenant_deposit_policy_revisions
BEGIN
  -- REPLACE would delete the revision or key it collides with before inserting.
  SELECT RAISE(ABORT, 'tenant_deposit_policy_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM tenant_deposit_policy_revisions existing
     WHERE existing.revision_id = NEW.revision_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
  );
  -- The writer names the revision after the one it read, so a stale change never lands.
  SELECT RAISE(ABORT, 'tenant_deposit_policy_version_conflict')
  WHERE NEW.revision != COALESCE((
    SELECT MAX(revision) FROM tenant_deposit_policy_revisions WHERE tenant_id = NEW.tenant_id
  ), 0) + 1;
  -- The owner's decision: an active owner of this tenant right now, never the QA seed owner.
  SELECT RAISE(ABORT, 'tenant_deposit_policy_owner_required')
  WHERE NOT EXISTS (
    SELECT 1
      FROM app_users owner
     WHERE owner.tenant_id = NEW.tenant_id
       AND owner.user_id = NEW.set_by_user_id
       AND owner.active = 1
       AND owner.access_role = 'owner'
       AND owner.created_by != 'system:owner_directed_qa_seed_grant'
  );
END;

-- One audit row per revision, keyed by `run_id = revision_id`. The reason stays on the revision.
CREATE TRIGGER IF NOT EXISTS tenant_deposit_policy_revisions_audit
AFTER INSERT ON tenant_deposit_policy_revisions
BEGIN
  INSERT INTO audit_log (
    ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
    run_id, approved_by
  )
  VALUES (
    NEW.set_at,
    'tenant_deposit_policy',
    'person',
    NULL,
    'tenant:' || NEW.tenant_id || ',revision:' || NEW.revision,
    'tenant_deposit_policy_revision:' || NEW.revision_id,
    'set:' || NEW.policy,
    'ok',
    NEW.revision_id,
    NEW.set_by_user_id
  );
END;

CREATE TRIGGER IF NOT EXISTS tenant_deposit_policy_revisions_append_only_update
BEFORE UPDATE ON tenant_deposit_policy_revisions
BEGIN
  SELECT RAISE(ABORT, 'tenant_deposit_policy_append_only');
END;

CREATE TRIGGER IF NOT EXISTS tenant_deposit_policy_revisions_append_only_delete
BEFORE DELETE ON tenant_deposit_policy_revisions
BEGIN
  SELECT RAISE(ABORT, 'tenant_deposit_policy_append_only');
END;

DROP TRIGGER IF EXISTS commercial_acceptance_enqueue_deposit_derivation;
CREATE TRIGGER commercial_acceptance_enqueue_deposit_derivation
AFTER INSERT ON commercial_acceptance_bindings
BEGIN
  SELECT RAISE(ABORT, 'commercial_deposit_source_missing')
   WHERE NOT EXISTS (
     SELECT 1
       FROM customer_portal_acceptance_intents acceptance
       JOIN commercial_quote_revisions quote
         ON quote.tenant_id = NEW.tenant_id
        AND quote.quote_revision_id = NEW.quote_revision_id
       JOIN commercial_proposal_revisions proposal
         ON proposal.tenant_id = NEW.tenant_id
        AND proposal.proposal_revision_id = NEW.proposal_revision_id
       JOIN commercial_proposal_publication_events publication
         ON publication.tenant_id = NEW.tenant_id
        AND publication.proposal_revision_id = proposal.proposal_revision_id
        AND publication.proposal_pack_id = proposal.proposal_pack_id
      WHERE acceptance.tenant_id = NEW.tenant_id
        AND acceptance.acceptance_id = NEW.acceptance_id
        AND acceptance.state = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions successor
           WHERE successor.tenant_id = proposal.tenant_id
             AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM commercial_proposal_revisions other
           WHERE other.tenant_id = proposal.tenant_id
             AND other.proposal_pack_id = proposal.proposal_pack_id
             AND other.proposal_revision_id != proposal.proposal_revision_id
             AND NOT EXISTS (
               SELECT 1 FROM commercial_proposal_revisions other_successor
                WHERE other_successor.tenant_id = other.tenant_id
                  AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
             )
        )
        AND publication.publication_version = (
          SELECT MAX(current.publication_version)
            FROM commercial_proposal_publication_events current
           WHERE current.tenant_id = publication.tenant_id
             AND current.proposal_pack_id = publication.proposal_pack_id
             AND current.occurred_at <= NEW.accepted_at
        )
     AND publication.state = 'published'
     AND publication.occurred_at <= NEW.accepted_at
   );
  -- [0155] The tenant's deposit policy decides which contract may be accepted. Under
  -- `od01_payment_on_completion`, also the policy of a tenant with no revision, the only legal
  -- contract has no deposit and is paid on completion.
  SELECT RAISE(ABORT, 'deposit_terms_not_allowed_by_policy')
   WHERE COALESCE((
       SELECT revision.policy FROM tenant_deposit_policy_revisions revision
        WHERE revision.tenant_id = NEW.tenant_id
        ORDER BY revision.revision DESC LIMIT 1
     ), 'od01_payment_on_completion') = 'od01_payment_on_completion'
     AND NOT EXISTS (
       SELECT 1
         FROM commercial_quote_revisions quote
        WHERE quote.tenant_id = NEW.tenant_id
          AND quote.quote_revision_id = NEW.quote_revision_id
          AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
          AND json_extract(quote.terms_json, '$.deposit_percent') = 0
          AND json_type(quote.terms_json, '$.payment_schedule') = 'array'
          AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
          AND json_extract(quote.terms_json, '$.payment_schedule[0]') = 'completion'
     );
  -- The commercial contract is an integer percentage.  SQLite's CAST would turn a browser- or
  -- legacy-supplied string/decimal/out-of-range value into a different amount, so reject the
  -- acceptance atomically before deriving any accounting basis.
  -- [0155] This is the `md13_deposit` rule: 1 to 100, and 0 aborts.
  SELECT RAISE(ABORT, 'commercial_deposit_percent_invalid')
   WHERE COALESCE((
       SELECT revision.policy FROM tenant_deposit_policy_revisions revision
        WHERE revision.tenant_id = NEW.tenant_id
        ORDER BY revision.revision DESC LIMIT 1
     ), 'od01_payment_on_completion') = 'md13_deposit'
     AND NOT EXISTS (
     SELECT 1
       FROM commercial_quote_revisions quote
      WHERE quote.tenant_id = NEW.tenant_id
        AND quote.quote_revision_id = NEW.quote_revision_id
        AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
        AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100
   );
  INSERT INTO commercial_deposit_derivations (
    derivation_id, acceptance_binding_id, acceptance_id, tenant_id, quote_revision_id,
    proposal_revision_id, proposal_version, publication_event_id, publication_version,
    roof_job_id, customer_id, customer_quote_id, quote_version,
    quote_currency, quote_subtotal_cents, quote_tax_cents, quote_total_cents, deposit_percent,
    terms_hash, receipt_hash, accepted_at, basis_json, basis_sha256, evidence_refs_json,
    command_fingerprint, idempotency_key_hash, state, intent_id, blocker_code,
    blocker_next_step, version, created_at, updated_at
  )
  SELECT
    'commercial-deposit-derivation:' || NEW.acceptance_binding_id,
    NEW.acceptance_binding_id, NEW.acceptance_id, NEW.tenant_id, NEW.quote_revision_id,
    NEW.proposal_revision_id, proposal.revision_number, publication.publication_event_id,
    publication.publication_version, NEW.roof_job_id, NEW.customer_id, quote.customer_quote_id,
    quote.revision_number, quote.currency, quote.subtotal_cents, quote.tax_cents,
    quote.total_cents, json_extract(quote.terms_json, '$.deposit_percent'),
    NEW.terms_hash, NEW.receipt_hash, NEW.accepted_at,
    json_object(
      'schema_version', 'ironwrap.commercial-deposit-basis.v1',
      'tenant_id', NEW.tenant_id,
      'acceptance_id', NEW.acceptance_id,
      'acceptance_binding_id', NEW.acceptance_binding_id,
      'quote_revision_id', NEW.quote_revision_id,
      'quote_evidence_digest', quote.evidence_digest,
      'proposal_revision_id', NEW.proposal_revision_id,
      'proposal_version', proposal.revision_number,
      'proposal_evidence_digest', proposal.evidence_digest,
      'publication_event_id', publication.publication_event_id,
      'publication_version', publication.publication_version,
      'publication_evidence_digest', publication.evidence_digest,
      'roof_job_id', NEW.roof_job_id,
      'customer_id', NEW.customer_id,
      'customer_quote_id', quote.customer_quote_id,
      'quote_version', quote.revision_number,
      'quote_currency', quote.currency,
      'quote_subtotal_cents', quote.subtotal_cents,
      'quote_tax_cents', quote.tax_cents,
      'quote_total_cents', quote.total_cents,
      'deposit_percent', json_extract(quote.terms_json, '$.deposit_percent'),
      'terms_hash', NEW.terms_hash,
      'receipt_hash', NEW.receipt_hash,
      'accepted_at', NEW.accepted_at
    ),
    NULL,
    json_array(
      json_object('ref', 'd1://commercial_acceptance_bindings/' || NEW.acceptance_binding_id,
                  'sha256', NEW.receipt_hash),
      json_object('ref', 'd1://commercial_quote_revisions/' || NEW.quote_revision_id,
                  'sha256', quote.evidence_digest),
      json_object('ref', 'd1://commercial_proposal_revisions/' || NEW.proposal_revision_id,
                  'sha256', proposal.evidence_digest),
      json_object('ref', 'd1://commercial_proposal_publication_events/' || publication.publication_event_id,
                  'sha256', publication.evidence_digest)
    ),
    acceptance.request_fingerprint, acceptance.idempotency_key_hash, 'pending', NULL, NULL,
    NULL, 1, NEW.bound_at, NEW.bound_at
  FROM customer_portal_acceptance_intents acceptance
  JOIN commercial_quote_revisions quote
    ON quote.tenant_id = NEW.tenant_id AND quote.quote_revision_id = NEW.quote_revision_id
  JOIN commercial_proposal_revisions proposal
    ON proposal.tenant_id = NEW.tenant_id
   AND proposal.proposal_revision_id = NEW.proposal_revision_id
  JOIN commercial_proposal_publication_events publication
    ON publication.tenant_id = NEW.tenant_id
   AND publication.proposal_revision_id = proposal.proposal_revision_id
   AND publication.proposal_pack_id = proposal.proposal_pack_id
  WHERE acceptance.tenant_id = NEW.tenant_id AND acceptance.acceptance_id = NEW.acceptance_id
    AND acceptance.state = 'accepted'
    AND NOT EXISTS (
      SELECT 1 FROM commercial_proposal_revisions successor
       WHERE successor.tenant_id = proposal.tenant_id
         AND successor.supersedes_proposal_revision_id = proposal.proposal_revision_id
    )
    AND NOT EXISTS (
      SELECT 1 FROM commercial_proposal_revisions other
       WHERE other.tenant_id = proposal.tenant_id
         AND other.proposal_pack_id = proposal.proposal_pack_id
         AND other.proposal_revision_id != proposal.proposal_revision_id
         AND NOT EXISTS (
           SELECT 1 FROM commercial_proposal_revisions other_successor
            WHERE other_successor.tenant_id = other.tenant_id
              AND other_successor.supersedes_proposal_revision_id = other.proposal_revision_id
         )
    )
    AND publication.publication_version = (
      SELECT MAX(current.publication_version)
        FROM commercial_proposal_publication_events current
       WHERE current.tenant_id = publication.tenant_id
         AND current.proposal_pack_id = publication.proposal_pack_id
         AND current.occurred_at <= NEW.accepted_at
    )
    AND publication.state = 'published'
    AND publication.occurred_at <= NEW.accepted_at
    -- [0155] Only a contract that carries a deposit has one to derive.
    AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100;
END;

DROP TRIGGER IF EXISTS production_gate_clearances_validate_insert;
CREATE TRIGGER production_gate_clearances_validate_insert
BEFORE INSERT ON production_gate_clearances
BEGIN
  -- Legacy entries come only from the backfill above.
  SELECT RAISE(ABORT, 'production_gate_clearance_legacy_closed')
  WHERE NEW.entry_kind = 'legacy';

  -- The entry names this tenant's gate as it stands now.
  SELECT RAISE(ABORT, 'production_gate_clearance_gate_invalid')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.roof_job_id = NEW.roof_job_id
       AND gate.gate = NEW.gate
  );
  SELECT RAISE(ABORT, 'production_gate_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.version = NEW.from_gate_version
  );

  -- Safety and Weather are never waivable, and Crew has no waiver.
  SELECT RAISE(ABORT, 'production_gate_not_waivable')
  WHERE NEW.basis = 'office_waiver' AND NEW.gate NOT IN ('Deposit', 'Materials', 'Access');

  -- [0155] Only a superseding contract reverses `contract_no_deposit`; a person never does.
  SELECT RAISE(ABORT, 'production_gate_contract_no_deposit_not_reversible')
  WHERE NEW.actor_kind IS NOT 'policy'
    AND NEW.reverses_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances reversed
       WHERE reversed.tenant_id = NEW.tenant_id
         AND reversed.clearance_id = NEW.reverses_id
         AND reversed.basis = 'contract_no_deposit'
    );

  -- [0155] A policy entry is the Deposit gate's, under `ironwrap.deposit-gate.v1`: `clear` with
  -- `contract_no_deposit`, or the `reverse` a superseding contract makes, `contract_superseded`.
  -- It names the contract it was read from and carries no person, request, reason or attestation,
  -- so the person rules below never apply to it.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NEW.actor_kind = 'policy'
    AND NOT (
      NEW.gate = 'Deposit'
      AND NEW.policy_version IS 'ironwrap.deposit-gate.v1'
      AND NEW.actor_user_id IS NULL AND NEW.actor_role IS NULL
      AND NEW.requested_by IS NULL AND NEW.request_id IS NULL AND NEW.self_approval = 0
      AND NEW.reason IS NULL AND NEW.reason_redacted_at IS NULL AND NEW.attestation_json IS NULL
      AND NEW.contract_binding_id IS NOT NULL AND NEW.terms_hash IS NOT NULL
      AND NEW.evidence_refs_json IS NOT NULL
      AND (
        (NEW.entry_kind = 'clear' AND NEW.basis = 'contract_no_deposit'
          AND NEW.to_state = 'complete' AND NEW.reverses_id IS NULL)
        OR (NEW.entry_kind = 'reverse' AND NEW.basis = 'contract_superseded'
          AND NEW.to_state = 'blocked' AND NEW.reverses_id IS NOT NULL)
      )
    );

  -- The basis x gate matrix this migration admits, all of it person entries.
  -- [0155] Scoped to every entry that is not a policy entry; the rule above checks those.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NEW.actor_kind IS NOT 'policy' AND (NOT (
      (NEW.entry_kind = 'clear' AND NEW.basis = 'deposit_settlement'
        AND NEW.gate = 'Deposit' AND NEW.to_state = 'complete'
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
      OR (NEW.entry_kind = 'waiver_request' AND NEW.basis = 'office_waiver'
        AND NEW.to_state = 'blocked'
        AND NEW.request_id IS NULL AND NEW.requested_by IS NULL)
      OR (NEW.entry_kind = 'waiver_decision' AND NEW.basis = 'office_waiver'
        AND NEW.to_state IN ('waived', 'blocked') AND NEW.requested_by IS NOT NULL)
    )
    OR NEW.actor_kind IS NOT 'person'
    OR NEW.actor_user_id IS NULL
    OR NEW.reverses_id IS NOT NULL
    OR NEW.reason_redacted_at IS NOT NULL
    OR (NEW.self_approval = 1 AND NEW.actor_user_id IS NOT NEW.requested_by)
    -- No entry admitted here carries attestation or contract facts, and a waiver carries no
    -- structured evidence either; attestation entries widen this when they arrive.
    OR NEW.attestation_json IS NOT NULL
    OR NEW.policy_version IS NOT NULL
    OR NEW.terms_hash IS NOT NULL
    OR NEW.contract_binding_id IS NOT NULL
    OR (NEW.entry_kind IN ('waiver_request', 'waiver_decision')
        AND NEW.evidence_refs_json IS NOT NULL));

  -- Each admitted entry acts on a blocked gate.
  -- [0155] Except the policy's `contract_superseded` reversal, which acts on the gate it reverses.
  SELECT RAISE(ABORT, 'production_gate_already_cleared')
  WHERE NEW.entry_kind IS NOT 'reverse' AND NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.state = 'blocked'
  );

  -- A person entry: an active user of this tenant holding the recorded role right now.
  -- [0155] Scoped to person entries; a policy entry names no user.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE NEW.actor_kind = 'person' AND NOT EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.active = 1
       AND actor.access_role = NEW.actor_role
  );
  SELECT RAISE(ABORT, 'production_gate_clearance_seed_identity_refused')
  WHERE EXISTS (
    SELECT 1
      FROM app_users actor
     WHERE actor.tenant_id = NEW.tenant_id
       AND actor.user_id = NEW.actor_user_id
       AND actor.created_by = 'system:owner_directed_qa_seed_grant'
  );

  -- `production.gates.clear` (owner, production) clears on settlement and requests a waiver. The
  -- decider holds the matching set: `money.approve` for Deposit, `production.gates.waive` for
  -- Materials and Access. Today the owner carries both.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE (NEW.entry_kind IN ('clear', 'waiver_request')
         AND NEW.actor_role NOT IN ('owner', 'production'))
     OR (NEW.entry_kind = 'waiver_decision' AND NEW.actor_role != 'owner');

  SELECT RAISE(ABORT, 'production_gate_clearance_reason_required')
  WHERE NEW.entry_kind IN ('waiver_request', 'waiver_decision')
    AND (NEW.reason IS NULL OR length(trim(NEW.reason)) = 0);

  -- One open waiver request per gate per person: a second would only move the gate's version
  -- under the owner deciding the first.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_open')
  WHERE NEW.entry_kind = 'waiver_request'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances request
       WHERE request.tenant_id = NEW.tenant_id
         AND request.gate_id = NEW.gate_id
         AND request.entry_kind = 'waiver_request'
         AND request.actor_user_id = NEW.actor_user_id
         AND NOT EXISTS (
           SELECT 1
             FROM production_gate_clearances decision
            WHERE decision.tenant_id = request.tenant_id
              AND decision.request_id = request.clearance_id
         )
    );

  -- A settlement is made of a reconciled deposit invoice of this job, named in the evidence.
  SELECT RAISE(ABORT, 'deposit_settlement_not_observed')
  WHERE NEW.basis = 'deposit_settlement'
    AND NOT EXISTS (
      SELECT 1
        FROM accounting_intents intent
       WHERE intent.tenant_id = NEW.tenant_id
         AND intent.roof_job_id = NEW.roof_job_id
         AND intent.kind = 'deposit_invoice'
         AND intent.state = 'reconciled'
         AND intent.settled_amount IS NOT NULL
         AND CAST(replace(intent.settled_amount, '.', '') AS INTEGER) > 0
         AND intent.intent_id = CASE
           WHEN json_valid(NEW.evidence_refs_json)
             THEN json_extract(NEW.evidence_refs_json, '$.money_intent_id')
         END
    );

  -- A decision answers a request for the same gate, made by `requested_by`, at most once.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_invalid')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
        FROM production_gate_clearances request
       WHERE request.tenant_id = NEW.tenant_id
         AND request.clearance_id = NEW.request_id
         AND request.gate_id = NEW.gate_id
         AND request.entry_kind = 'waiver_request'
         AND request.actor_user_id = NEW.requested_by
    );
  SELECT RAISE(ABORT, 'production_gate_waiver_already_decided')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NOT NULL
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances decision
       WHERE decision.tenant_id = NEW.tenant_id
         AND decision.request_id = NEW.request_id
    );
  -- With no request, a decision is the requester deciding their own item.
  SELECT RAISE(ABORT, 'production_gate_waiver_request_invalid')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.request_id IS NULL
    AND NEW.requested_by IS NOT NEW.actor_user_id;

  -- Requester != decider, except the only active holder of the set approving their own item
  -- (D-08). The QA seed owner never decides, so it is not counted as a holder.
  SELECT RAISE(ABORT, 'production_gate_waiver_self_approval_refused')
  WHERE NEW.entry_kind = 'waiver_decision'
    AND NEW.actor_user_id = NEW.requested_by
    AND (
      NEW.self_approval != 1
      OR NEW.to_state != 'waived'
      OR EXISTS (
        SELECT 1
          FROM app_users holder
         WHERE holder.tenant_id = NEW.tenant_id
           AND holder.user_id != NEW.actor_user_id
           AND holder.active = 1
           AND holder.access_role = 'owner'
           AND holder.created_by != 'system:owner_directed_qa_seed_grant'
      )
    );

  -- [0155] `contract_no_deposit` (OD-01): the job's latest accepted contract, exactly as its
  -- binding recorded it, carries no deposit and is paid on completion.
  SELECT RAISE(ABORT, 'production_gate_contract_no_deposit_not_observed')
  WHERE NEW.basis = 'contract_no_deposit'
    AND NOT EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings binding
        JOIN customer_portal_acceptance_intents acceptance
          ON acceptance.tenant_id = binding.tenant_id
         AND acceptance.acceptance_id = binding.acceptance_id
         AND acceptance.state = 'accepted'
        JOIN commercial_quote_revisions quote
          ON quote.tenant_id = binding.tenant_id
         AND quote.quote_revision_id = binding.quote_revision_id
       WHERE binding.tenant_id = NEW.tenant_id
         AND binding.roof_job_id = NEW.roof_job_id
         AND binding.acceptance_binding_id = NEW.contract_binding_id
         AND binding.terms_hash = NEW.terms_hash
         AND quote.terms_hash = binding.terms_hash
         AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
         AND json_extract(quote.terms_json, '$.deposit_percent') = 0
         AND json_type(quote.terms_json, '$.payment_schedule') = 'array'
         AND json_array_length(quote.terms_json, '$.payment_schedule') = 1
         AND json_extract(quote.terms_json, '$.payment_schedule[0]') = 'completion'
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings later
            WHERE later.tenant_id = binding.tenant_id
              AND later.roof_job_id = binding.roof_job_id
              AND (later.accepted_at > binding.accepted_at
                   OR (later.accepted_at = binding.accepted_at
                       AND later.acceptance_binding_id > binding.acceptance_binding_id))
         )
    );
  -- [0155] ... and the tenant's deposit policy is payment on completion. No revision means OD-01.
  SELECT RAISE(ABORT, 'deposit_terms_not_allowed_by_policy')
  WHERE NEW.basis = 'contract_no_deposit'
    AND COALESCE((
      SELECT revision.policy FROM tenant_deposit_policy_revisions revision
       WHERE revision.tenant_id = NEW.tenant_id
       ORDER BY revision.revision DESC LIMIT 1
    ), 'od01_payment_on_completion') != 'od01_payment_on_completion';

  -- [0155] `contract_superseded` (the MD-13 branch): the job's latest accepted contract is a later
  -- one that carries a deposit, and the entry reversed is the `contract_no_deposit` entry the
  -- Deposit gate stands on now.
  SELECT RAISE(ABORT, 'production_gate_contract_superseded_not_observed')
  WHERE NEW.basis = 'contract_superseded'
    AND NOT (
      EXISTS (
        SELECT 1
          FROM operating_production_gates gate
          JOIN production_gate_clearances reversed
            ON reversed.tenant_id = gate.tenant_id
           AND reversed.clearance_id = gate.clearance_decision_id
         WHERE gate.tenant_id = NEW.tenant_id
           AND gate.gate_id = NEW.gate_id
           AND gate.state = 'complete'
           AND reversed.clearance_id = NEW.reverses_id
           AND reversed.gate_id = NEW.gate_id
           AND reversed.basis = 'contract_no_deposit'
           AND reversed.contract_binding_id IS NOT NEW.contract_binding_id
      )
      AND EXISTS (
        SELECT 1
          FROM commercial_acceptance_bindings binding
          JOIN customer_portal_acceptance_intents acceptance
            ON acceptance.tenant_id = binding.tenant_id
           AND acceptance.acceptance_id = binding.acceptance_id
           AND acceptance.state = 'accepted'
          JOIN commercial_quote_revisions quote
            ON quote.tenant_id = binding.tenant_id
           AND quote.quote_revision_id = binding.quote_revision_id
         WHERE binding.tenant_id = NEW.tenant_id
           AND binding.roof_job_id = NEW.roof_job_id
           AND binding.acceptance_binding_id = NEW.contract_binding_id
           AND binding.terms_hash = NEW.terms_hash
           AND quote.terms_hash = binding.terms_hash
           AND json_type(quote.terms_json, '$.deposit_percent') = 'integer'
           AND json_extract(quote.terms_json, '$.deposit_percent') BETWEEN 1 AND 100
           AND NOT EXISTS (
             SELECT 1
               FROM commercial_acceptance_bindings later
              WHERE later.tenant_id = binding.tenant_id
                AND later.roof_job_id = binding.roof_job_id
                AND (later.accepted_at > binding.accepted_at
                     OR (later.accepted_at = binding.accepted_at
                         AND later.acceptance_binding_id > binding.acceptance_binding_id))
           )
      )
    );

  -- [0155] Once a superseding contract has re-blocked Deposit, a settlement is made of the
  -- deposit invoice derived from the job's latest accepted contract, not of any deposit invoice.
  SELECT RAISE(ABORT, 'deposit_settlement_not_observed')
  WHERE NEW.basis = 'deposit_settlement'
    AND EXISTS (
      SELECT 1
        FROM production_gate_clearances superseded
       WHERE superseded.tenant_id = NEW.tenant_id
         AND superseded.gate_id = NEW.gate_id
         AND superseded.basis = 'contract_superseded'
    )
    AND NOT EXISTS (
      SELECT 1
        FROM commercial_acceptance_bindings binding
        JOIN commercial_deposit_derivations derivation
          ON derivation.tenant_id = binding.tenant_id
         AND derivation.acceptance_binding_id = binding.acceptance_binding_id
       WHERE binding.tenant_id = NEW.tenant_id
         AND binding.roof_job_id = NEW.roof_job_id
         AND derivation.intent_id = CASE
           WHEN json_valid(NEW.evidence_refs_json)
             THEN json_extract(NEW.evidence_refs_json, '$.money_intent_id')
         END
         AND NOT EXISTS (
           SELECT 1
             FROM commercial_acceptance_bindings later
            WHERE later.tenant_id = binding.tenant_id
              AND later.roof_job_id = binding.roof_job_id
              AND (later.accepted_at > binding.accepted_at
                   OR (later.accepted_at = binding.accepted_at
                       AND later.acceptance_binding_id > binding.acceptance_binding_id))
         )
    );
END;

-- 0153's replace guard, unchanged, re-created after the guard above so it still fires first:
-- triggers on one table fire newest first.
DROP TRIGGER IF EXISTS production_gate_clearances_no_insert_replace;
CREATE TRIGGER production_gate_clearances_no_insert_replace
BEFORE INSERT ON production_gate_clearances
BEGIN
  SELECT RAISE(ABORT, 'production_gate_clearance_append_only')
  WHERE EXISTS (
    SELECT 1
      FROM production_gate_clearances existing
     WHERE existing.clearance_id = NEW.clearance_id
        OR (existing.tenant_id = NEW.tenant_id
            AND existing.idempotency_key_hash = NEW.idempotency_key_hash)
  );
  SELECT RAISE(ABORT, 'production_gate_version_conflict')
  WHERE EXISTS (
    SELECT 1
      FROM production_gate_clearances existing
     WHERE existing.tenant_id = NEW.tenant_id
       AND existing.gate_id = NEW.gate_id
       AND existing.from_gate_version = NEW.from_gate_version
  );
END;
