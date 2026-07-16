# Market Defense

## Purpose
Triage competitor and product-market changes into tracked Market Watch Items and map each to an IronWrap product gate as covered, exceeded, or open. Keep the six-month market-defense bar honest instead of drifting.

## When to use
- A competitor ships a feature (instant estimates, field AI, production tooling, measurement/3D, proposals).
- The owner asks which competitor claims IronWrap already covers, exceeds, or has not answered.

## Inputs
- Frappe: `list_market_watch_items` (Market Watch Item: `competitor`, `title`, `risk_level`, `status` Open/Covered/Exceeded/Responding/Dismissed, `product_gate`, `required_response`).
- Blueprint references: the Six-Month Market Defense Bar table and the Maturity Gates list in `docs/HERMES-ERPNEXT-END-PRODUCT-BLUEPRINT.md`.
- The competitor set from tenant config `market_defense.competitor_set`.

## Procedure
1. Read the current watch list with `list_market_watch_items` (optionally filtered by status) to see what is already tracked and open.
2. For a new competitor change, identify the competitor, the change, and the IronWrap product gate it pressures (for example Roofr instant estimates map to gate 5, CompanyCam field AI to gate 9, Eagleview/Hover to gate 6).
3. Assign a risk level (Low, Medium, High) based on how directly it threatens a gate IronWrap has not yet cleared.
4. Preview with `dry_run_market_watch_item` (competitor, title, risk_level, product_gate, required_response), then obtain the short-lived `dry_run_receipt` and a separately signed human `approval_receipt` for the exact request before calling `request_add_market_watch_item`. This creates or updates one Market Watch Item at status Open and records a Hermes Run row.
5. Classify the item against the gate: Covered (gate met), Exceeded (IronWrap stronger), or Open (gap). A human sets Responding or Dismissed.
6. Produce the owner-facing map of competitor claims to covered / exceeded / open gates, and flag any Open High-risk item as a product decision.

## Guardrails
- Never mark an item Covered or Exceeded without evidence that the mapped gate is actually met.
- Never dismiss a High-risk item without a human decision recorded in `decision_notes`.
- This skill tracks and maps only; it does not change product scope or ship features.
- Every add or update is review-gated and audited like any approved write.

## Output
A Market Watch Item per tracked change and an owner-facing covered / exceeded / open map tying competitor pressure to specific product gates, each backed by a Hermes Run audit row.
