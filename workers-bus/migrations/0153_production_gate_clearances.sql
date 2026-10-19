-- 0153_production_gate_clearances.sql - a production gate moves only by an entry in its ledger.
--
-- `operating_production_gates` stays the current-state row the scheduling guard (0098) reads, but
-- nothing writes it directly any more. A gate changes only when an entry is appended to
-- `production_gate_clearances`: the apply trigger sets the state, bumps the version, fills the
-- 0106 clearance columns and writes one `audit_log` row in the same statement.
--
-- What may be appended (the basis x gate x actor matrix) is held here as well as in the Worker:
--   * `clear` / `deposit_settlement`: Deposit only, to `complete`, by a person holding
--     `production.gates.clear` (owner or production), and only while a reconciled deposit invoice
--     of the same job is named in the evidence.
--   * `waiver_request` / `office_waiver`: Deposit, Materials or Access, by a
--     `production.gates.clear` holder, with a reason. The gate stays `blocked`.
--   * `waiver_decision` / `office_waiver`: by a holder of the matching set, `money.approve` for
--     Deposit and `production.gates.waive` for Materials and Access; today the owner carries both.
--     An approval waives the gate and a decline leaves it blocked. The decider is never the
--     requester, with one exception (owner ruling D-08): when no other active holder of the set
--     exists, the requester may approve their own item with a reason, recorded as
--     `self_approval = 1`, `self_approval_basis = 'only_holder'`.
--   * Safety and Weather are never waivable, and Crew has no waiver.
--   * Every person entry is refused for the QA seed owner identity
--     (`created_by = 'system:owner_directed_qa_seed_grant'`), which also never counts as a holder.
-- Attestation, reversal and policy entries come with their own changes; until then this
-- migration refuses them.
--
-- Gates already out of `blocked` keep their state: the backfill records each as one `legacy`
-- entry before any guard exists, and no `legacy` entry can be appended after it.

CREATE TABLE IF NOT EXISTS production_gate_clearances (
  clearance_id TEXT PRIMARY KEY CHECK (
    length(clearance_id) = 44
    AND substr(clearance_id, 1, 4) = 'pgc_'
    AND substr(clearance_id, 5) NOT GLOB '*[^0-9a-f]*'
  ),
  tenant_id TEXT NOT NULL CHECK (
    length(tenant_id) BETWEEN 2 AND 64
    AND tenant_id NOT GLOB '*[^a-z0-9-]*'
  ),
  gate_id TEXT NOT NULL,
  roof_job_id TEXT NOT NULL,
  gate TEXT NOT NULL CHECK (
    gate IN ('Deposit', 'Materials', 'Safety', 'Access', 'Weather', 'Crew', 'Completion')
  ),
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN ('clear', 'reverse', 'waiver_request', 'waiver_decision', 'legacy')
  ),
  -- The basis vocabulary lives in the validate trigger, so a later change widens it without a
  -- table rebuild. '(none)' marks a legacy gate that recorded no basis.
  basis TEXT NOT NULL CHECK (
    length(basis) BETWEEN 3 AND 64 AND basis NOT GLOB '*[^a-z0-9_()]*'
  ),
  to_state TEXT NOT NULL CHECK (
    to_state IN ('blocked', 'ready', 'in_progress', 'complete', 'waived')
  ),
  -- The gate version the entry was appended at; applying it leaves the gate at the next version.
  -- A legacy entry stands for the change that produced the gate's version at backfill.
  from_gate_version INTEGER NOT NULL CHECK (from_gate_version BETWEEN 0 AND 1000000),
  reverses_id TEXT,
  request_id TEXT,
  actor_kind TEXT CHECK (actor_kind IS NULL OR actor_kind IN ('person', 'policy')),
  actor_user_id TEXT CHECK (
    actor_user_id IS NULL OR (
      length(actor_user_id) BETWEEN 8 AND 200
      AND actor_user_id NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  actor_role TEXT CHECK (
    actor_role IS NULL OR actor_role IN (
      'owner', 'ops', 'sales', 'admin', 'production', 'shop', 'accounting', 'field'
    )
  ),
  requested_by TEXT CHECK (
    requested_by IS NULL OR (
      length(requested_by) BETWEEN 8 AND 200
      AND requested_by NOT GLOB '*[^A-Za-z0-9._:-]*'
    )
  ),
  self_approval INTEGER NOT NULL DEFAULT 0 CHECK (self_approval IN (0, 1)),
  self_approval_basis TEXT CHECK (
    self_approval_basis IS NULL OR self_approval_basis = 'only_holder'
  ),
  policy_version TEXT CHECK (
    policy_version IS NULL OR length(trim(policy_version)) BETWEEN 1 AND 120
  ),
  contract_binding_id TEXT CHECK (
    contract_binding_id IS NULL OR length(trim(contract_binding_id)) BETWEEN 1 AND 200
  ),
  terms_hash TEXT CHECK (
    terms_hash IS NULL OR (length(terms_hash) = 64 AND terms_hash NOT GLOB '*[^0-9a-f]*')
  ),
  attestation_json TEXT CHECK (
    attestation_json IS NULL OR (
      length(attestation_json) BETWEEN 2 AND 8000
      AND json_valid(attestation_json)
      AND json_type(attestation_json) = 'object'
    )
  ),
  -- Copied onto the gate's 0106 `evidence_refs_json`, so it has that column's shape. Structured
  -- references only: free text belongs in `reason`.
  evidence_refs_json TEXT CHECK (
    evidence_refs_json IS NULL OR (
      length(trim(evidence_refs_json)) BETWEEN 2 AND 4000
      AND substr(trim(evidence_refs_json), 1, 1) IN ('{', '[')
    )
  ),
  -- The only free text, and the only value that may change after insert: a redaction clears it
  -- and stamps `reason_redacted_at`.
  reason TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 1 AND 1000),
  reason_redacted_at TEXT CHECK (
    reason_redacted_at IS NULL OR length(reason_redacted_at) BETWEEN 20 AND 40
  ),
  request_sha256 TEXT CHECK (
    request_sha256 IS NULL
    OR (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*')
  ),
  idempotency_key_hash TEXT CHECK (
    idempotency_key_hash IS NULL OR (
      length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  legacy_decision_id TEXT CHECK (
    legacy_decision_id IS NULL OR length(legacy_decision_id) BETWEEN 1 AND 160
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  UNIQUE (clearance_id, tenant_id),
  UNIQUE (tenant_id, gate_id, from_gate_version),
  UNIQUE (tenant_id, idempotency_key_hash),
  CHECK (
    (self_approval = 0 AND self_approval_basis IS NULL)
    OR (self_approval = 1 AND self_approval_basis = 'only_holder')
  ),
  CHECK (reason_redacted_at IS NULL OR reason IS NULL),
  -- A legacy entry records a clearance made before this ledger existed: no actor kind the ledger
  -- can vouch for, no request hash and no idempotency key. Every other entry carries all three.
  CHECK (
    (entry_kind = 'legacy' AND actor_kind IS NULL
      AND request_sha256 IS NULL AND idempotency_key_hash IS NULL)
    OR (entry_kind != 'legacy' AND actor_kind IS NOT NULL
      AND request_sha256 IS NOT NULL AND idempotency_key_hash IS NOT NULL
      AND legacy_decision_id IS NULL)
  ),
  FOREIGN KEY (gate_id, tenant_id)
    REFERENCES operating_production_gates(gate_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (request_id, tenant_id)
    REFERENCES production_gate_clearances(clearance_id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (reverses_id, tenant_id)
    REFERENCES production_gate_clearances(clearance_id, tenant_id) ON DELETE RESTRICT
);

-- A waiver request is decided at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_production_gate_clearances_request
  ON production_gate_clearances (tenant_id, request_id)
  WHERE request_id IS NOT NULL;

-- Backfill, before any guard below exists. Each gate already out of `blocked` gets the one legacy
-- entry that explains its state: the basis it recorded (or '(none)'), its actor as recorded, its
-- raw clearance decision id in `legacy_decision_id`, and its clearance time. A pre-ledger waiver
-- kept its reason inside the gate's evidence JSON; the entry carries it in the redactable `reason`
-- instead. Re-running adds nothing.
INSERT INTO production_gate_clearances (
  clearance_id, tenant_id, gate_id, roof_job_id, gate, entry_kind, basis, to_state,
  from_gate_version, actor_user_id, evidence_refs_json, reason, legacy_decision_id, created_at
)
SELECT
  'pgc_' || lower(hex(randomblob(20))),
  gate.tenant_id,
  gate.gate_id,
  gate.roof_job_id,
  gate.gate,
  'legacy',
  COALESCE(gate.clearance_basis, '(none)'),
  gate.state,
  gate.version - 1,
  gate.cleared_by_user_id,
  CASE WHEN gate.clearance_basis IS NOT 'office_waiver' THEN gate.evidence_refs_json END,
  CASE WHEN gate.clearance_basis = 'office_waiver' AND json_valid(gate.evidence_refs_json) THEN
    CASE WHEN json_type(gate.evidence_refs_json, '$.waiver_reason') = 'text'
          AND length(trim(json_extract(gate.evidence_refs_json, '$.waiver_reason')))
              BETWEEN 1 AND 1000
         THEN trim(json_extract(gate.evidence_refs_json, '$.waiver_reason'))
    END
  END,
  gate.clearance_decision_id,
  COALESCE(gate.cleared_at, gate.updated_at)
FROM operating_production_gates gate
WHERE gate.state != 'blocked'
  AND NOT EXISTS (
    SELECT 1
      FROM production_gate_clearances entry
     WHERE entry.tenant_id = gate.tenant_id
       AND entry.gate_id = gate.gate_id
       AND entry.from_gate_version = gate.version - 1
  );

-- One audit row per legacy entry, keyed like every entry's row by `run_id = clearance_id`.
INSERT INTO audit_log (
  ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
  run_id, approved_by
)
SELECT
  entry.created_at,
  'production_gate_clearance',
  'migration',
  NULL,
  'job:' || entry.roof_job_id || ',gate:' || entry.gate
    || ',from_version:' || entry.from_gate_version || ',to_state:' || entry.to_state,
  'production_gate_clearance:' || entry.clearance_id || ',production_gate:' || entry.gate_id,
  'legacy:' || entry.basis,
  'ok',
  entry.clearance_id,
  entry.actor_user_id
FROM production_gate_clearances entry
WHERE entry.entry_kind = 'legacy'
  AND NOT EXISTS (SELECT 1 FROM audit_log audit WHERE audit.run_id = entry.clearance_id);

CREATE TRIGGER IF NOT EXISTS production_gate_clearances_validate_insert
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

  -- The basis x gate matrix this migration admits, all of it person entries.
  SELECT RAISE(ABORT, 'production_gate_clearance_basis_invalid')
  WHERE NOT (
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
    OR (NEW.self_approval = 1 AND NEW.actor_user_id IS NOT NEW.requested_by);

  -- Each admitted entry acts on a blocked gate.
  SELECT RAISE(ABORT, 'production_gate_already_cleared')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.state = 'blocked'
  );

  -- A person entry: an active user of this tenant holding the recorded role right now.
  SELECT RAISE(ABORT, 'production_gate_clearance_actor_invalid')
  WHERE NOT EXISTS (
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
END;

CREATE TRIGGER IF NOT EXISTS production_gate_clearances_apply
AFTER INSERT ON production_gate_clearances
BEGIN
  UPDATE operating_production_gates
     SET state = NEW.to_state,
         version = version + 1,
         updated_at = NEW.created_at,
         clearance_basis = CASE
           WHEN NEW.to_state != 'blocked'
            AND NEW.basis IN ('office_waiver', 'deposit_settlement')
             THEN NEW.basis
         END,
         clearance_decision_id = CASE WHEN NEW.to_state != 'blocked' THEN NEW.clearance_id END,
         cleared_by_user_id = CASE WHEN NEW.to_state != 'blocked' THEN NEW.actor_user_id END,
         evidence_refs_json = CASE WHEN NEW.to_state != 'blocked' THEN NEW.evidence_refs_json END,
         cleared_at = CASE WHEN NEW.to_state != 'blocked' THEN NEW.created_at END
   WHERE tenant_id = NEW.tenant_id
     AND gate_id = NEW.gate_id
     AND version = NEW.from_gate_version;

  SELECT RAISE(ABORT, 'production_gate_version_conflict')
  WHERE NOT EXISTS (
    SELECT 1
      FROM operating_production_gates gate
     WHERE gate.tenant_id = NEW.tenant_id
       AND gate.gate_id = NEW.gate_id
       AND gate.version = NEW.from_gate_version + 1
       AND gate.state = NEW.to_state
  );

  -- Free text stays in the redactable ledger column; the audit row carries identifiers only.
  INSERT INTO audit_log (
    ts, automation, trigger, envelope_id, source_ids, target_ids, action, result,
    run_id, approved_by
  )
  VALUES (
    NEW.created_at,
    'production_gate_clearance',
    NEW.actor_kind,
    NULL,
    'job:' || NEW.roof_job_id || ',gate:' || NEW.gate
      || ',from_version:' || NEW.from_gate_version || ',to_state:' || NEW.to_state
      || CASE WHEN NEW.request_id IS NOT NULL THEN ',request:' || NEW.request_id ELSE '' END
      || CASE WHEN NEW.self_approval = 1
           THEN ',self_approval:' || NEW.self_approval_basis ELSE '' END,
    'production_gate_clearance:' || NEW.clearance_id || ',production_gate:' || NEW.gate_id,
    NEW.entry_kind || ':' || NEW.basis,
    'ok',
    NEW.clearance_id,
    NEW.actor_user_id
  );
END;

-- Append-only. The single permitted change is a redaction: clearing `reason` and stamping
-- `reason_redacted_at`, with every other column unchanged. A column added to this table later
-- must be added to this list.
CREATE TRIGGER IF NOT EXISTS production_gate_clearances_append_only_update
BEFORE UPDATE ON production_gate_clearances
WHEN NOT (
  OLD.reason IS NOT NULL AND NEW.reason IS NULL
  AND OLD.reason_redacted_at IS NULL AND NEW.reason_redacted_at IS NOT NULL
  AND NEW.clearance_id IS OLD.clearance_id AND NEW.tenant_id IS OLD.tenant_id
  AND NEW.gate_id IS OLD.gate_id AND NEW.roof_job_id IS OLD.roof_job_id
  AND NEW.gate IS OLD.gate AND NEW.entry_kind IS OLD.entry_kind
  AND NEW.basis IS OLD.basis AND NEW.to_state IS OLD.to_state
  AND NEW.from_gate_version IS OLD.from_gate_version
  AND NEW.reverses_id IS OLD.reverses_id AND NEW.request_id IS OLD.request_id
  AND NEW.actor_kind IS OLD.actor_kind AND NEW.actor_user_id IS OLD.actor_user_id
  AND NEW.actor_role IS OLD.actor_role AND NEW.requested_by IS OLD.requested_by
  AND NEW.self_approval IS OLD.self_approval
  AND NEW.self_approval_basis IS OLD.self_approval_basis
  AND NEW.policy_version IS OLD.policy_version
  AND NEW.contract_binding_id IS OLD.contract_binding_id
  AND NEW.terms_hash IS OLD.terms_hash
  AND NEW.attestation_json IS OLD.attestation_json
  AND NEW.evidence_refs_json IS OLD.evidence_refs_json
  AND NEW.request_sha256 IS OLD.request_sha256
  AND NEW.idempotency_key_hash IS OLD.idempotency_key_hash
  AND NEW.legacy_decision_id IS OLD.legacy_decision_id
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'production_gate_clearance_append_only');
END;

CREATE TRIGGER IF NOT EXISTS production_gate_clearances_append_only_delete
BEFORE DELETE ON production_gate_clearances
BEGIN
  SELECT RAISE(ABORT, 'production_gate_clearance_append_only');
END;

-- A gate row changes only as the apply of the entry appended at its current version. The 0090
-- version guard makes every update a version change, so this covers every column.
CREATE TRIGGER IF NOT EXISTS operating_production_gates_state_guard
BEFORE UPDATE ON operating_production_gates
WHEN NOT EXISTS (
  SELECT 1
    FROM production_gate_clearances entry
   WHERE entry.tenant_id = OLD.tenant_id
     AND entry.gate_id = OLD.gate_id
     AND entry.from_gate_version = OLD.version
     AND entry.entry_kind != 'legacy'
     AND entry.to_state = NEW.state
)
BEGIN
  SELECT RAISE(ABORT, 'operating_production_gates_ledger_required');
END;

-- A gate is created blocked at version 1 with no clearance, as the operating-core materializer
-- writes it. AFTER INSERT, so a retried `ON CONFLICT DO NOTHING` write never reaches it, while a
-- REPLACE over a gate that has ledger history is refused.
CREATE TRIGGER IF NOT EXISTS operating_production_gates_state_guard_insert
AFTER INSERT ON operating_production_gates
WHEN NEW.state != 'blocked'
  OR NEW.version != 1
  OR NEW.clearance_basis IS NOT NULL
  OR NEW.clearance_decision_id IS NOT NULL
  OR NEW.cleared_by_user_id IS NOT NULL
  OR NEW.evidence_refs_json IS NOT NULL
  OR NEW.cleared_at IS NOT NULL
  OR EXISTS (
    SELECT 1
      FROM production_gate_clearances entry
     WHERE entry.tenant_id = NEW.tenant_id
       AND entry.gate_id = NEW.gate_id
  )
BEGIN
  SELECT RAISE(ABORT, 'operating_production_gates_ledger_required');
END;

-- REPLACE would delete an earlier entry before inserting. Created last, so it fires first.
CREATE TRIGGER IF NOT EXISTS production_gate_clearances_no_insert_replace
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
