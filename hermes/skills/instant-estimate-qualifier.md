# Instant Estimate Qualifier

## Purpose
Qualify a public estimator-review request without inventing a price. Identify missing project facts, preserve consent evidence, and route the request to measurement and estimator review.

## When to use
- A homeowner completed the public estimate widget and an Instant Estimate Session exists.
- A lead asks "roughly what will this cost?" before verified measurement and approved pricing evidence exist.

## Inputs
- Frappe: `get_instant_estimate_session` / `list_instant_estimate_sessions_for_job` (Instant Estimate Session: `service_type`, `review_required`, `status`).
- Context: `get_lead_envelope`, `get_roof_job`, `list_evidence_for_job` (any homeowner-supplied photos).
- Tenant policy: `estimates.instant_estimate` (`online_price=false`, `measurement_required=true`, `review_required=true`, disclaimer).

## Procedure
1. Read the session with `get_instant_estimate_session`; confirm it is `Captured` and `review_required` is true.
2. Confirm service type is in scope (roofing, metal_roofing, siding, gutters, soffit_fascia). If out of scope, route to a human, do not estimate.
3. List the facts required before pricing: verified geometry/measurements, access and complexity review, material system/selections, and an effective approved pricing policy.
4. Record missing facts explicitly; never replace them with assumed size, pitch, waste, material tier, labour, freight, tax, or price.
5. Attach the tenant disclaimer verbatim.
6. This skill writes no Frappe record and emits no numeric range. It returns a review checklist for the estimator and lead-triage flow.

## Guardrails
- Never present a price or range from public intake facts alone.
- Never call this a quote, a final price, or a discount.
- Never bypass the review gate: `review_required` stays true until an estimator reviews.
- No takeoff, supplier quote, or accounting write. This skill has no approved-write tools of its own.

## Output
A price-free estimator checklist with explicit missing evidence and the mandatory disclaimer.
