# Production Gatekeeper

## Purpose
Enforce the production gate rules for a Roof Job: Deposit, Materials, Safety, Access, Weather, Crew, and Completion. A job may not schedule or proceed while a required gate is Blocked, unless a human explicitly waives it with a reason.

## When to use
- A won job is entering production and its gates need to be checked or updated.
- The Production Board shows a blocker and someone asks whether the job can proceed.

## Inputs
- Frappe: `get_roof_job`, `list_job_gates`, `list_blocked_jobs`, material/order reads, plus `get_crew_profile`, `list_job_assignments_for_job`, `list_change_orders_for_job`, `list_safety_plans_for_job`, and `list_job_compliance_records_for_job`.

## Procedure
1. Read all gates with `list_job_gates` for the Roof Job. Identify which of the seven gates are Blocked, Ready, Waived, or Done.
2. For each gate, check evidence: keep Deposit blocked unless owner/finance-verified payment truth is attached; check Materials against approved takeoff/order; Crew against an active Crew Profile and current Job Assignment; Safety against a Ready plan and evidence-backed acknowledgement; compliance against the required jurisdiction record; Completion against completion evidence.
3. Create a new assignment through `dry_run_job_assignment` then `request_create_job_assignment`. Schedule/crew corrections must use a new assignment id, `supersedes`, and a reason; never overwrite history.
4. Create or correct safety plans through `dry_run_safety_plan` / `request_create_safety_plan`; Ready requires evidence. Record acknowledgement only through its dry-run/write pair and one of QR Device Pairing, E-signature, or In Person, always with linked evidence.
5. Create or transition compliance records through `dry_run_job_compliance_record` / `request_record_job_compliance`; never move Approved/Passed/Failed/Waived without evidence.
6. Preview any gate change with `dry_run_update_gate`. On human approval call `request_update_gate` with a stable `run_id`; Blocked/Waived requires a written reason.
7. Never advance a job while a required gate is Blocked. Report the full gate, assignment, safety, compliance, and change-order map; waivers remain human decisions.

## Guardrails
- Never start or schedule a job while a required gate is Blocked. Gate logic plus human approval enforce this.
- Never waive a gate without a human `approved_by` and a written reason.
- Never silently overwrite assignment, safety-plan, compliance, or change-order history.
- Never touch estimator pricing or send customer communication (out of role scope).
- No accounting mutation; deposit truth comes from QuickBooks-mirrored Payment Milestones.

## Output
An updated Production Gate State with recorded reason and override history, plus a Hermes Run audit row, and a clear proceed / blocked verdict for the job.
