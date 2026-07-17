# Proposal Proof Pack

## Purpose
Assemble the customer-facing evidence narrative for a proposal into a review-gated Proposal Evidence Pack: measurements, photos, and proof links that let every proposal line trace back to evidence. No price or scope is committed by this skill.

## When to use
- An estimator is ready to build a proposal and needs the evidence bundle assembled.
- The Customer Portal proof room needs a refreshed evidence pack for an approved quote.

## Inputs
- Frappe: `get_roof_job`, measurement/evidence/proposal-pack reads, plus `get_change_order` / `list_change_orders_for_job`, `get_customer_decision` / `list_customer_decisions_for_job`, and read-only Contract Acceptance tools.

## Procedure
1. Read `get_roof_job`, the exact `Customer Quote`, and source evidence with measurement/evidence tools.
2. Confirm the quote belongs to the same Roof Job, is `Approved` or `Accepted`, and carries its immutable Price Book Rule snapshot; a revised quote receives a new proof pack. If the snapshot is missing, stop and use the separate governed price-rule binding pair while the quote is Draft or Needs Review.
3. Preview with `dry_run_proposal_evidence_pack` using both `roof_job_id` and `customer_quote_id`. Review only its redacted count/identity summary.
4. Resolve any missing measurement approval or evidence that is unsafe, unverified, checksumless, provenance-free, or missing a proof slot.
5. On human approval, call `request_create_proposal_evidence_pack` with `roof_job_id`, `customer_quote_id`, `request_text`, `approved_by`, `dry_run_receipt`, and a signed `approval_receipt`. This creates or updates only that quote-owned Draft pack and records a Hermes Run audit row.
6. Once the pack itself is reviewed and an existing private portal link is the intended proof room, only Owner Operator may dry-run `dry_run_publish_proposal_evidence_pack` and then call `request_publish_proposal_evidence_pack` with its matching receipts. It can promote only that locked Draft pack to Approved.
7. For scope changes, create a new change-order version via its dry-run/write pair. Corrections must append and supersede; marking Presented requires linked evidence of a human/provider presentation, and no tool can send or transition to Accepted/Rejected for the customer.
8. Record a customer decision only from linked evidence of a decision already made. Read Contract Acceptance to verify provider/customer action; never create or alter it.
9. Confirm every line links back to its source. Publication shows a safe summary through an already-issued private link; the human still owns any actual send or e-sign handoff.

## Guardrails
- Never set a customer-facing price, scope, option selection, or payment term. Those require separate human approval before send.
- Never include non-`customer_safe`, missing, or ambiguous evidence in the pack.
- Never add source URIs, R2/Drive keys, raw evidence summaries, or a customer message to the pack.
- Never promote a pack except through the Owner Operator-only receipt-bound publication command, and never beyond `Approved`.
- Never treat publication as a portal-link issuance, document render/download, customer message, e-sign action, or customer acceptance.
- Never send the proposal. This skill assembles proof only; a human sends.
- Never sign, accept, reject, or create Contract Acceptance on the customer's behalf.
- No accounting mutation.

## Output
A review-gated Proposal Evidence Pack (Draft, or Approved only after the separate Owner Operator publication command), bound to one approved quote and containing only a redacted evidence summary, plus a Hermes Run audit row.
