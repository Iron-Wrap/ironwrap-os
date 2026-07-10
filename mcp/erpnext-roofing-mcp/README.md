# erpnext-roofing-mcp

Narrow MCP server for the proprietary IronWrap OS Frappe app. The `erpnext-*`
name is retained only for compatibility; ERPNext is not installed or linked.

This server is the Hermes command surface over IronWrap OS business truth. It uses
Frappe token auth and exposes read tools plus token-gated approved-write tools:

- `get_roof_job`
- `get_lead_envelope`
- `list_job_gates`
- `list_blocked_jobs`
- `get_measurement_report`
- `list_measurement_reports_for_job`
- `get_material_takeoff`
- `list_material_takeoffs_for_job`
- `get_supplier_order`
- `list_supplier_orders_for_job`
- `get_instant_estimate_session`
- `list_instant_estimate_sessions_for_job`
- `get_evidence_item`
- `list_evidence_for_job`
- `get_field_check_in`
- `list_field_check_ins_for_job`
- `get_proposal_evidence_pack`
- `list_proposal_evidence_packs_for_job`
- `get_payment_milestone`
- `list_payment_milestones_for_job`
- `get_hermes_run`
- `list_hermes_runs_for_job`
- `get_completion_packet`
- `list_completion_packets_for_job`
- `get_warranty_packet`
- `list_warranty_packets_for_job`
- `get_review_request`
- `list_review_requests_for_job`
- `get_communication_event`
- `list_communication_events_for_job`
- `get_supplier_quote`
- `list_supplier_quotes_for_job`
- `list_market_watch_items`
- `get_price_book_rule` / `list_price_book_rules`
- `get_visual_property_model` / `list_visual_property_models_for_job`
- `get_roof_area` / `list_roof_areas_for_job`
- `get_option_package` / `list_option_packages_for_job`
- `get_scope_clause` / `list_scope_clauses_for_job`
- `get_automation_incident` / `list_automation_incidents`
- `get_white_label_tenant` / `list_white_label_tenants`
- `check_consent`
- `check_quiet_hours`
- `dry_run_update_gate`
- `request_update_gate`
- `dry_run_material_takeoff`
- `request_create_material_takeoff`
- `dry_run_update_material_takeoff_status`
- `request_update_material_takeoff_status`
- `dry_run_supplier_order`
- `request_create_supplier_order`
- `dry_run_supplier_quote`
- `request_create_supplier_quote`
- `dry_run_proposal_evidence_pack`
- `request_create_proposal_evidence_pack`
- `dry_run_completion_packet`
- `request_create_completion_packet`
- `dry_run_warranty_packet`
- `request_create_warranty_packet`
- `dry_run_review_request`
- `request_create_review_request`
- `dry_run_communication_event`
- `request_record_communication_event`
- `dry_run_market_watch_item`
- `request_add_market_watch_item`

Estimator intake enters IronWrap OS through the Worker `POST /ingest/estimate` route first. This MCP
server reads the resulting `Instant Estimate Session` rows and can draft downstream takeoff/proposal
work, but it does not accept raw public estimator submissions itself.

Write tools are disabled unless `ERPNEXT_WRITE_ENABLED=true` and
`HERMES_WRITE_TOKEN` are set. Every request requires a caller-supplied stable
`run_id`, approver, request text, and approval token. The token is redacted from
the `Hermes Run` audit payload. An exact completed retry returns the stored
result; an `Audit Failed` run proves the target mutation happened and is never
reapplied.

Current approved-write tools:

- `request_update_gate` updates one `Production Gate State`.
- `request_create_material_takeoff` creates or updates one review-gated
  `Material Takeoff` from linked Measurement Report values. It does not approve
  quantities, create supplier orders, create purchase orders, or mutate invoices.
- `request_update_material_takeoff_status` updates one `Material Takeoff`
  review status with an approval note and Hermes Run audit row. It does not
  create supplier orders, purchase orders, invoices, or customer-facing scope.
- `request_create_supplier_order` creates or updates one internal, review-gated
  `Supplier Order` draft from an approved `Material Takeoff`. It does not place
  orders, reserve material, contact suppliers, or mutate accounting.
- `request_create_proposal_evidence_pack` creates or updates one draft
  `Proposal Evidence Pack` from linked Measurement Report and Evidence Item
  rows. It does not approve pricing, scope, payment terms, material orders, or
  customer send.
- `request_create_supplier_quote` creates or updates one review-gated
  `Supplier Quote` (with `valid_until` and per-line prices) from an approved
  `Material Takeoff`. It does not place orders or commit pricing.
- `request_create_completion_packet` creates or updates one review-gated
  `Completion Packet` from Field Check-in and photo Evidence Item rows. It
  requires photo evidence and never sets warranty readiness itself.
- `request_create_warranty_packet` creates or updates one `Warranty Packet`
  draft, allowed only from an approved, warranty-ready `Completion Packet`.
  It does not issue the warranty or notify the customer.
- `request_create_review_request` records one `Review Request` as Eligible or
  Blocked from deterministic stop conditions (approved completion packet,
  payment evidence, consent). It never marks a request Sent.
- `request_record_communication_event` records one policy-gated
  `Communication Event` (consent plus quiet hours) as Draft or Blocked. It
  never sends a message; sending stays a human action.
- `request_add_market_watch_item` creates or updates one `Market Watch Item`
  for the market-defense loop.

Required environment:

```bash
ERPNEXT_BASE_URL=https://erp.example.com
ERPNEXT_API_KEY=...
ERPNEXT_API_SECRET=...
ERPNEXT_WRITE_ENABLED=false
HERMES_WRITE_TOKEN=...
ERPNEXT_REQUEST_TIMEOUT_MS=10000
```

Production URLs must use HTTPS. Plain HTTP is rejected unless the hostname is
localhost and `ERPNEXT_ALLOW_INSECURE_LOCAL=true` is explicitly set for local
development.

Run locally:

```bash
npm install
npm test
npm start
```
