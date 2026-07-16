# Instant Estimate Qualifier

## Purpose
Produce a non-binding budget range for a homeowner from an Instant Estimate Session, backed by an explicit assumptions ledger, and never as a committed price. All numbers stay labeled as a range pending estimator review.

## When to use
- A homeowner completed the public estimate widget and an Instant Estimate Session exists.
- A lead asks "roughly what will this cost?" before any measurement or estimator review.

## Inputs
- Frappe: `get_instant_estimate_session` / `list_instant_estimate_sessions_for_job` (Instant Estimate Session: `service_type`, `range_low`, `range_high`, `estimate_total`, `review_required`, `status`).
- Context: `get_lead_envelope`, `get_roof_job`, `list_evidence_for_job` (any homeowner-supplied photos).
- Tenant policy: `estimates.instant_estimate` (non_binding=true, review_required=true, disclaimer).

## Procedure
1. Read the session with `get_instant_estimate_session`; confirm `review_required` is true and the session is non-binding.
2. Confirm service type is in scope (roofing, metal_roofing, siding, gutters, soffit_fascia). If out of scope, route to a human, do not estimate.
3. Build a range from the session inputs only. Record every assumption in a ledger: assumed size, pitch, access, material tier, and any unknown treated as a placeholder.
4. State exclusions clearly: no measurement verification, no material selection lock, no access/complexity survey, no permit or structural review.
5. Attach the tenant disclaimer verbatim: "This is a non-binding budget range based on the information you provided. Final pricing requires an estimator review of measurements, access, and material selections."
6. This skill writes no Frappe record itself. It emits the range, ledger, and disclaimer for a human and for the lead-triage first-response draft.
7. If a customer-facing draft carries the range, route it through the Lead Triage comms path (`check_consent` -> `check_quiet_hours` -> `dry_run_communication_event` -> `request_record_communication_event`). The range text must keep the disclaimer.

## Guardrails
- Never present a number without the non-binding label and disclaimer. No price promise, ever.
- Never call this a quote, a final price, or a discount.
- Never bypass the review gate: `review_required` stays true until an estimator reviews.
- No takeoff, supplier quote, or accounting write. This skill has no approved-write tools of its own.

## Output
A non-binding budget range with an assumptions ledger, explicit exclusions, and the mandatory disclaimer, ready for human review and (via Lead Triage) an optional record-only draft.
