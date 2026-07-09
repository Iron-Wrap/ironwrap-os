# Proposal Proof Pack

## Purpose
Assemble the customer-facing evidence narrative for a proposal into a review-gated Proposal Evidence Pack: measurements, photos, and proof links that let every proposal line trace back to evidence. No price or scope is committed by this skill.

## When to use
- An estimator is ready to build a proposal and needs the evidence bundle assembled.
- The Customer Portal proof room needs a refreshed evidence pack for a job.

## Inputs
- ERPNext: `get_roof_job`, `list_measurement_reports_for_job` (Measurement Report), `list_evidence_for_job` (Evidence Item: `evidence_type`, `customer_safe`, `source_uri`), `get_proposal_evidence_pack` / `list_proposal_evidence_packs_for_job` (Proposal Evidence Pack: `status`, `pack_id`).

## Procedure
1. Read `get_roof_job` and gather source evidence with `list_measurement_reports_for_job` and `list_evidence_for_job`.
2. Preview with `dry_run_proposal_evidence_pack` (roof_job_id). Review the assembled `evidence_summary_json`: measurement report count and evidence item count.
3. Verify each customer-facing evidence item is `customer_safe`. Exclude anything unsafe, missing, or ambiguous; note it for resolution.
4. Write the customer narrative describing what the evidence shows, without price, without accepted scope, without payment commitment.
5. On human approval, call `request_create_proposal_evidence_pack` with `roof_job_id`, `request_text`, `approved_by`, `approval_token` (HERMES_WRITE_TOKEN). This upserts a Proposal Evidence Pack at status Draft and records a Hermes Run audit row.
6. Confirm the pack links back to its measurement and evidence sources so every proposal line is explainable. Hand the pack id to the estimator for final proposal approval and send (a human action).

## Guardrails
- Never set a customer-facing price, scope, option selection, or payment term. Those require separate human approval before send.
- Never include non-`customer_safe`, missing, or ambiguous evidence in the pack.
- Never send the proposal. This skill assembles proof only; a human sends.
- No accounting mutation.

## Output
A review-gated Proposal Evidence Pack (Draft) with an evidence summary linking measurements and photos, plus a Hermes Run audit row, ready for estimator approval.
