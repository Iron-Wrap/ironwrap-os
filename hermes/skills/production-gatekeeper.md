# Production Gatekeeper

## Purpose
Enforce the production gate rules for a Roof Job: Deposit, Materials, Safety, Access, Weather, Crew, and Completion. A job may not schedule or proceed while a required gate is Blocked, unless a human explicitly waives it with a reason.

## When to use
- A won job is entering production and its gates need to be checked or updated.
- The Production Board shows a blocker and someone asks whether the job can proceed.

## Inputs
- ERPNext: `get_roof_job`, `list_job_gates` (Production Gate State: `gate`, `state` Blocked/Ready/Waived/Done, `blocker_reason`), `list_blocked_jobs`, `get_material_takeoff` / `list_material_takeoffs_for_job`, `get_supplier_order` / `list_supplier_orders_for_job`, `get_payment_milestone` / `list_payment_milestones_for_job`, `list_field_check_ins_for_job`.

## Procedure
1. Read all gates with `list_job_gates` for the Roof Job. Identify which of the seven gates are Blocked, Ready, Waived, or Done.
2. For each gate, check its evidence: Deposit against Payment Milestone status, Materials against approved Material Takeoff and Supplier Order, Safety/Access/Weather/Crew against field readiness, Completion against completion evidence.
3. Preview any change with `dry_run_update_gate` (gate_id, next_state, reason). A reason is required to move a gate to Blocked or Waived.
4. On human approval, call `request_update_gate` with `gate_id`, `next_state`, `reason`, `request_text`, `approved_by`, `approval_token` (HERMES_WRITE_TOKEN). This updates one Production Gate State and records a Hermes Run audit row.
5. Never advance a job to production while a required gate is Blocked. A Waived gate must carry a human `approved_by` and a reason; surface the override in the audit trail.
6. Report the full gate map and any blocker to the owner; the decision to waive is a human one.

## Guardrails
- Never start or schedule a job while a required gate is Blocked. Gate logic plus human approval enforce this.
- Never waive a gate without a human `approved_by` and a written reason.
- Never touch estimator pricing or send customer communication (out of role scope).
- No accounting mutation; deposit truth comes from QuickBooks-mirrored Payment Milestones.

## Output
An updated Production Gate State with recorded reason and override history, plus a Hermes Run audit row, and a clear proceed / blocked verdict for the job.
