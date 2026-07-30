# Metal Roofing Takeoff

## Purpose
Turn approved measurement evidence into a review-gated Material Takeoff: panels, trim, gauges, colors, fasteners, waste factors, and supplier assumptions. Every quantity is a draft for estimator review, never an order.

## When to use
- A Measurement Report is parsed and an estimator needs a takeoff drafted from it.
- An existing takeoff needs its review status set to Approved or Rejected.

## Inputs
- IronWrap OS: approved Measurement Reports, `get_visual_property_model` /
  `list_visual_property_models_for_job`, `get_roof_area` / `list_roof_areas_for_job`,
  Material Takeoffs, and `get_price_book_rule` / `list_price_book_rules`.
- Tenant materials: suppliers, profiles, gauges, and colors from the tenant's controlled catalogue.
  An absent, expired, or placeholder catalogue blocks SKU, supplier, and availability selection.

## Procedure
1. Read the source Measurement Report with `get_measurement_report`; confirm it has parsed measurement values. If none, stop (the tool rejects empty measurements).
2. Preview with `dry_run_material_takeoff` (roof_job_id, optional measurement_report_id). Review draft `items`: categories (Roof Surface, Linear Metal), quantities, and waste factors (Roof Surface 10%, Linear Metal 5%).
3. Record profile/gauge/color assumptions in the takeoff assumptions field and mark each
   `needs_review`. If the controlled catalogue is unavailable, record the missing input and stop
   before naming a SKU, supplier, substitution, or availability state.
4. On human approval, call `request_create_material_takeoff` with a new stable `run_id`,
   `roof_job_id`, `request_text`, `approved_by`, and `dry_run_receipt` plus a signed `approval_receipt`.
   This upserts a Material Takeoff at status Needs Review and records a Hermes Run audit row.
5. To move review status: `dry_run_update_material_takeoff_status` (takeoff_id, next_status, reason) then, on approval, `request_update_material_takeoff_status`. A reason is required for Approved or Rejected.
6. Only an Approved takeoff unlocks downstream Supplier Quote and Supplier Order drafts. Report that gate; do not force it.

## Guardrails
- Never place an order, reserve material, or contact a supplier. This creates internal draft records only.
- Never approve a takeoff without a human `approved_by` and the approval token; all writes are review-gated.
- Never fabricate measurement values, waste factors beyond the deterministic defaults, or supplier availability.
- No accounting mutation, no comms send.

## Output
A review-gated Material Takeoff (Needs Review, then Approved or Rejected by a human) with evidence-linked line items and a Hermes Run audit row.
