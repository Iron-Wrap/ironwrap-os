# Proposal Proof Pack

## Purpose
Assemble the customer-facing evidence narrative for a proposal into a review-gated Proposal Evidence Pack: measurements, photos, and proof links that let every proposal line trace back to evidence. No price or scope is committed by this skill.

## When to use
- An estimator is ready to build a proposal and needs the evidence bundle assembled.
- The Customer Portal proof room needs a refreshed evidence pack for a job.

## Inputs
- Frappe: `get_roof_job`, measurement/evidence/proposal-pack reads, plus `get_change_order` / `list_change_orders_for_job`, `get_customer_decision` / `list_customer_decisions_for_job`, and read-only Contract Acceptance tools.

## Procedure
1. Read `get_roof_job` and gather source evidence with `list_measurement_reports_for_job` and `list_evidence_for_job`.
2. Preview with `dry_run_proposal_evidence_pack` (roof_job_id). Review the assembled `evidence_summary_json`: measurement report count and evidence item count.
3. Verify each customer-facing evidence item is `customer_safe`. Exclude anything unsafe, missing, or ambiguous; note it for resolution.
4. Write the customer narrative describing what the evidence shows, without price, without accepted scope, without payment commitment.
5. On human approval, call `request_create_proposal_evidence_pack` with `roof_job_id`, `request_text`, `approved_by`, `dry_run_receipt` plus a signed `approval_receipt`. This upserts a Proposal Evidence Pack at status Draft and records a Hermes Run audit row.
6. For scope changes, create a new change-order version via its dry-run/write pair. Corrections must append and supersede; marking Presented requires linked evidence of a human/provider presentation, and no tool can send or transition to Accepted/Rejected for the customer.
7. Record a customer decision only from linked evidence of a decision already made. Read Contract Acceptance to verify provider/customer action; never create or alter it.
8. Confirm every line links back to its source. Hand the pack id to the estimator for final approval and human send.

## Guardrails
- Never set a customer-facing price, scope, option selection, or payment term. Those require separate human approval before send.
- Never include non-`customer_safe`, missing, or ambiguous evidence in the pack.
- Never send the proposal. This skill assembles proof only; a human sends.
- Never sign, accept, reject, or create Contract Acceptance on the customer's behalf.
- No accounting mutation.

## Output
A review-gated Proposal Evidence Pack (Draft) with an evidence summary linking measurements and photos, plus a Hermes Run audit row, ready for estimator approval.
