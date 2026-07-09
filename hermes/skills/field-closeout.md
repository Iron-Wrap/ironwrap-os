# Field Closeout

## Purpose
Turn field evidence into a review-gated Completion Packet and, once a human approves it and marks it warranty-ready, a Warranty Packet. This closes the job with proof, not assertion.

## When to use
- A crew reports a job finished and the completion evidence needs to be assembled.
- Someone asks whether a job is ready to close, invoice, or warranty.

## Inputs
- ERPNext: `get_roof_job`, `list_field_check_ins_for_job` (Field Check-in: `status`, `photo_count`), `list_evidence_for_job` / `get_evidence_item` (Evidence Item: `evidence_type` Photo / Voice Note), `list_completion_packets_for_job` / `get_completion_packet`, `list_warranty_packets_for_job` / `get_warranty_packet`.

## Procedure
1. Read field check-ins and evidence for the Roof Job. Confirm at least one Photo evidence item exists; a completion packet cannot be drafted without it.
2. Preview the completion packet with `dry_run_completion_packet` (roof_job_id). Review its assembled photo evidence, the deficiency list (built from any Needs Review check-ins), and that `warranty_ready` is 0.
3. On human approval, call `request_create_completion_packet` (roof_job_id, request_text, approved_by, approval_token). This creates or updates one review-gated Completion Packet at status Needs Review and records a Hermes Run audit row.
4. A human reviews the packet, resolves deficiencies, records the customer signoff reference, sets the packet Approved, and sets `warranty_ready`. Hermes does not set these itself.
5. Once the Completion Packet is Approved and warranty-ready, preview the warranty with `dry_run_warranty_packet` (completion_packet_id, material_system, coverage terms), then on approval call `request_create_warranty_packet` (completion_packet_id, request_text, approved_by, approval_token). It drafts a Warranty Packet at Needs Review and records a Hermes Run row.
6. Report closeout readiness (completion status, deficiencies, warranty draft) to the owner. Review-request eligibility is handled by the closeout agent through the alberta-compliance and market-defense skills, not here.

## Guardrails
- Never draft a completion packet without photo evidence (the builder errors without it).
- Never set `warranty_ready`, customer signoff, or Approved status by tool; those are human decisions.
- Never issue a warranty, notify the customer, or create an invoice or payment; the warranty packet is a draft only.
- No accounting mutation; invoice/payment truth stays in QuickBooks-mirrored Payment Milestones.

## Output
A review-gated Completion Packet (and, once approved and warranty-ready, a Warranty Packet draft), each linked to its field evidence with a Hermes Run audit row.
