# erpnext-roofing-mcp

Narrow MCP server for the proprietary IronWrap OS Frappe app. The `erpnext-*`
name is retained only for compatibility; ERPNext is not installed or linked.

This server is the Hermes command surface over IronWrap OS business truth. It uses
Frappe token auth. The implemented source contract is **119 tools: 73 reads, 23 dry-runs, and 23
approved writes**. The manifest in `hermes/mcp-servers.json` is the exact source-registration
inventory; deployed runtime proof remains a launch gate.

Baseline reads and command pairs:

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
- `get_customer_quote` / `list_customer_quotes_for_job` (strict projection; excludes tax,
  payment, acceptance, and notes)
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
- `dry_run_quote_revision`
- `request_create_quote_revision`
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

Committed 46-DocType operating-model additions:

- `get_crew_profile` / `list_crew_profiles` (strictly read-only)
- `get_job_assignment` / `list_job_assignments_for_job`
- `get_change_order` / `list_change_orders_for_job`
- `get_safety_plan` / `list_safety_plans_for_job`
- `get_job_compliance_record` / `list_job_compliance_records_for_job`
- `get_communication_consent` / `list_communication_consents_for_job`
- `get_customer_decision` / `list_customer_decisions_for_job`
- `get_contract_acceptance` / `list_contract_acceptances_for_job` (strictly read-only)
- `get_integration_reconciliation` / `list_integration_reconciliations_for_job`
- `get_tenant_export_run` / `list_tenant_export_runs_for_tenant`
- `dry_run_job_assignment` / `request_create_job_assignment`
- `dry_run_change_order` / `request_create_change_order`
- `dry_run_change_order_transition` / `request_transition_change_order`
- `dry_run_safety_plan` / `request_create_safety_plan`
- `dry_run_safety_acknowledgement` / `request_record_safety_acknowledgement`
- `dry_run_job_compliance_record` / `request_record_job_compliance`
- `dry_run_customer_decision` / `request_record_customer_decision`
- `dry_run_communication_consent` / `request_record_communication_consent`
- `dry_run_reconciliation_resolution` / `request_resolve_reconciliation`
- `dry_run_tenant_export` / `request_tenant_export`

Estimator intake enters IronWrap OS through the Worker `POST /ingest/estimate` route first. This MCP
server reads the resulting `Instant Estimate Session` rows and can draft downstream takeoff/proposal
work, but it does not accept raw public estimator submissions itself.

Frappe write tools are disabled unless `ERPNEXT_WRITE_ENABLED=true`. Every MCP
process must also bind one canonical `HERMES_AGENT_ROLE` and `HERMES_ACTOR_USER`;
the server registers only that role's `roles.json` allowlist. An approved request
needs a stable `run_id`, request text, approver, a short-lived server-issued
`dry_run_receipt`, and an independently signed `approval_receipt` for the exact
arguments, role, actor, and Frappe site. Receipt fields are redacted from the
`Hermes Run` audit payload. Creating the unique `Hermes Run` is the one mutation
claim. A source change or an already-created append-only target fails closed during
preview revalidation; an in-flight, failed, or audit-failed claim never re-executes
the mutation.

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
- `request_create_quote_revision` appends one blank `Customer Quote` Draft shell with
  verified source/job/customer/version/reason lineage. It never carries commercial or
  acceptance facts forward and cannot supersede an accepted or contract-linked quote.
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
- `request_create_job_assignment` appends one assignment. Schedule or crew corrections
  require a new id, `supersedes`, and a written reason.
- `request_create_change_order` appends a Draft change-order version;
  `request_transition_change_order` permits internal review transitions only. Neither tool
  can accept, reject, sign, or send for a customer; marking Presented requires linked evidence
  that a human/provider already performed the presentation.
- `request_create_safety_plan` appends a plan; Ready requires linked evidence.
  `request_record_safety_acknowledgement` invokes a locked Frappe command, rather than a
  generic parent update. It derives an active assignment role, requires verified safety
  proof owned/captured by the actor, and preserves exact device-action replay.
- `request_record_job_compliance` creates or legally transitions an evidence-gated
  compliance record without bypassing production gates.
- `request_record_customer_decision` appends evidence of a decision already made by a
  customer. `Contract Acceptance` has no write tool.
- `request_record_communication_consent` appends record-only consent history. Granted
  requires proof; Revoked/Superseded require explicit lineage and correction reason.
- `request_resolve_reconciliation` updates only an Integration Reconciliation record; it
  never mutates QuickBooks, payment, invoice, or another external system.
- `request_tenant_export` appends only a Requested Tenant Export Run. A separate audited
  worker creates/encrypts the archive, excluding credentials, sessions, and key material.
  The same caller-supplied `export_run_id` must be used in dry-run and approved request.

Required environment:

```bash
ERPNEXT_BASE_URL=https://erp.example.com
# Per-actor Frappe token: its API user must exactly equal HERMES_ACTOR_USER.
ERPNEXT_API_KEY=...
ERPNEXT_API_SECRET=...
ERPNEXT_WRITE_ENABLED=false
HERMES_AGENT_ROLE=owner-operator
HERMES_ACTOR_USER=owner@example.com
HERMES_APPROVER_ID=owner@example.com
HERMES_DRY_RUN_SIGNING_KEY=<at-least-32-byte-host-secret>
HERMES_APPROVAL_PUBLIC_KEY_FILE=/run/secrets/hermes-approval-public.pem
ERPNEXT_REQUEST_TIMEOUT_MS=10000
```

The private brokers hold the Ed25519 private key and start a fresh, fixed-role
MCP child only for their bounded endpoints. Lead triage remains
`node src/approval-broker.mjs` behind
`deploy/approval-broker.service.example`. Quote revision is a separate process:
`node src/quote-revision-approval-broker.mjs` behind
`deploy/quote-revision-approval-broker.service.example` with
`HERMES_AGENT_ROLE=estimator-assistant`, a different HMAC secret/key ID/port,
and only `/v1/quote-revision/preview` plus `/v1/quote-revision/execute`.

Both revalidate the exact dry-run packet, sign the receipt in memory, and never
return that receipt to the Worker or browser. The quote-revision broker stores
only a redacted preview plus the full receipt-preview digest, then reruns the
full dry run before it signs. It can create only a blank append-only Draft
shell—never price, tax, scope, payment, acceptance, or a customer message. The
legacy `tools/issue-hermes-approval.mjs` remains a host-side break-glass utility,
not an HTTP primitive. For an atomic safety acknowledgement, the Frappe API
token must belong to exactly `HERMES_ACTOR_USER`; a shared integration/service
account is rejected. Run one MCP process per actor and never reuse the Worker's
Frappe integration credential for that process.

Production URLs must use HTTPS. Plain HTTP is rejected unless the hostname is
localhost and `ERPNEXT_ALLOW_INSECURE_LOCAL=true` is explicitly set for local
development.

Run locally:

```bash
npm install
npm test
npm start
```
