# Metal Roofing Takeoff

## Purpose
Turn canonical `roof_graph/v1` geometry into a review-gated, reproducible Material Takeoff under one approved engineering policy. The calculation produces panel cuts, trim stock, fasteners, stock/coil consumption, and explicit waste basis. Every quantity remains an internal draft until estimator approval; it is never an order.

## When to use
- A Measurement Report carries canonical roof geometry and an estimator needs a takeoff drafted from it.
- An existing takeoff needs its review status set to Approved or Rejected.

## Inputs
- IronWrap OS: Measurement Reports with a bound roof-graph revision/raw SHA, `get_visual_property_model` /
  `list_visual_property_models_for_job`, `get_roof_area` / `list_roof_areas_for_job`,
  Material Takeoffs, and `get_price_book_rule` / `list_price_book_rules`.
- A stable `material_system` identifier and, when known, the exact `takeoff_policy_id`.
- One approved, effective Material Takeoff Policy bound to the MCP runtime tenant, Roof Job brand,
  service type, and material system. Its verified source evidence must define every panel, trim,
  stock/coil, cutting, waste, and fastener input. An absent, ambiguous, expired, cross-tenant, or
  placeholder policy blocks the calculation.

## Procedure
1. Read the Roof Job and source Measurement Report. Confirm `roof_graph_json`,
   `roof_graph_revision`, raw SHA, raw key, and Roof Job binding agree. Provider-declared measurement
   rows are comparison evidence only; they never become material quantities.
2. Confirm an approved, effective policy exists for the runtime tenant plus the exact Roof Job
   brand/service and requested `material_system`. Confirm the policy source Evidence Item is
   Verified with SHA-256. Stop if policy selection is missing or ambiguous.
3. Preview with `dry_run_material_takeoff` using `roof_job_id`, `material_system`, optional
   `measurement_report_id`, and optional exact `takeoff_policy_id`. Review the geometry revision,
   policy/options/calculation digests, panel cut schedule, trim schedule, fastener quantities,
   stock mode, waste basis, assumptions, and every `review_reasons_json` entry.
4. Never hand-edit computed rows or fill an absent input with a rule of thumb. Correct the source
   geometry or create a new reviewed policy version, then rerun the preview.
5. On human approval of the exact preview, call `request_create_material_takeoff` with the same
   source and policy arguments, a new stable `run_id`, `request_text`, `approved_by`,
   `dry_run_receipt`, and signed `approval_receipt`. This creates one Needs Review draft or performs
   a target-mutation-free replay bound to the existing draft's exact `prepared_at`, Measurement Report,
   and policy. A matching policy may be Retired for this historical replay only; rotation, legacy state,
   or any changed binding fails closed. The Hermes Run records whether the target was mutated.
6. Move review status only after the Measurement Report is Approved, all calculation review reasons
   are resolved, all item bindings match, and the policy remains Approved/effective:
   `dry_run_update_material_takeoff_status`, then `request_update_material_takeoff_status`. A reason
   is required for Approved or Rejected.
7. Only an Approved takeoff unlocks downstream Supplier Quote and Supplier Order drafts. Report that gate; do not force it.

## Guardrails
- Never place an order, reserve material, or contact a supplier. This creates internal draft records only.
- Never approve a takeoff without a human `approved_by` and exact signed receipts; all writes are review-gated.
- Never fabricate measurements, material mappings, panel coverage, trim laps, stock lengths,
  coil allowances, cutting limits, fastener spacing, waste, or supplier availability. There are no
  production defaults.
- Coil mode must carry explicit setup, tail, or scrap allowance. Zero-waste coil output is not operational evidence.
- Never select another tenant's policy or treat policy status text without verified approval/source binding as authority.
- No accounting mutation, no comms send.

## Output
A review-gated Material Takeoff (Needs Review, then Approved or Rejected by a human) with immutable geometry/policy/calculation bindings, evidence-linked computed rows, explicit review reasons, and a Hermes Run audit row.
