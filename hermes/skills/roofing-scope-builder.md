# Roofing Scope Builder

## Purpose
Draft the scope of work for a roof job: inclusions, exclusions, risk clauses, and good/better/best upgrade packages, all traceable to evidence and all subject to estimator approval before they reach a customer.

## When to use
- An estimator is preparing a proposal and needs structured scope clauses and option tiers.
- A takeoff or measurement is approved and the job needs its inclusions, exclusions, and risk language written down.

## Inputs
- ERPNext: `get_roof_job`, `get_measurement_report` / `list_measurement_reports_for_job`, `get_material_takeoff` / `list_material_takeoffs_for_job`, `list_evidence_for_job` (Evidence Item, note `customer_safe`).
- Tenant policy: `proposal.options_model` (good_better_best), `services`, `production.gates`.

## Procedure
1. Read `get_roof_job` and the linked approved Material Takeoff (`get_material_takeoff`, status must be Approved) plus its Measurement Report to ground every clause in evidence.
2. Draft inclusions: each line ties to a takeoff category (Roof Surface, Linear Metal) or an approved measurement metric. Cite the `source_ref`.
3. Draft exclusions explicitly: permits, structural repair, deck replacement beyond allowance, hidden damage, and anything not measured or approved.
4. Draft risk clauses: access constraints, weather dependency, unforeseen substrate, and material lead-time risk.
5. Build good/better/best option packages per `proposal.options_model`, describing material tier, warranty difference, and upgrade scope, with no committed price.
6. This skill produces draft scope text only. It has no dedicated write tool; the scope narrative feeds the Proposal Proof Pack skill, which assembles the Proposal Evidence Pack under approval.
7. Flag any clause that lacks evidence or requires an estimator pricing/substitution decision; do not resolve it silently.

## Guardrails
- Never commit a price, discount, or binding scope. Estimator approval is required for every clause and option.
- Never include unsafe or non-`customer_safe` evidence in customer-facing scope.
- Never invent measurements, warranty terms, or material specs not present in approved records.
- No accounting mutation, no comms send.

## Output
A structured scope draft: inclusions (evidence-linked), exclusions, risk clauses, and good/better/best option packages, ready for the Proposal Proof Pack and estimator approval.
